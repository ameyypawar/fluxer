// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, UserID} from '../../BrandedTypes';
import {BatchBuilder, fetchMany, fetchOne, upsertOne} from '../../database/CassandraQueryExecution';
import {Db} from '../../database/CassandraTypes';
import type {
	ChannelRow,
	ThreadArchiveDueRow,
	ThreadMemberRow,
	ThreadsByGuildRow,
	ThreadsByParentRow,
} from '../../database/types/ChannelTypes';
import {Channel} from '../../models/Channel';
import {ThreadArchiveDue, ThreadMembers, ThreadMembersByUser, Threads, ThreadsByGuild, ThreadsByParent} from './ThreadTables';
import {IThreadRepository} from './IThreadRepository';

const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_DUE_ROW_TTL_SECONDS = 45 * 24 * 60 * 60;
const ARCHIVE_DUE_FETCH_LIMIT = 500;

export function getThreadArchiveDueBucket(dueAt: Date): number {
	return Math.floor(dueAt.getTime() / DAY_MS);
}

const FETCH_THREAD_REFS_BY_PARENT = ThreadsByParent.select({
	where: ThreadsByParent.where.eq('parent_id'),
});
const FETCH_THREAD_REFS_BY_GUILD = ThreadsByGuild.select({
	where: ThreadsByGuild.where.eq('guild_id'),
});
const FETCH_THREAD_MEMBER = ThreadMembers.select({
	where: [ThreadMembers.where.eq('thread_id'), ThreadMembers.where.eq('user_id')],
	limit: 1,
});
const FETCH_THREAD_MEMBERS = ThreadMembers.select({
	where: ThreadMembers.where.eq('thread_id'),
});
const FETCH_JOINED_THREADS = ThreadMembersByUser.select({
	where: [ThreadMembersByUser.where.eq('user_id'), ThreadMembersByUser.where.eq('guild_id')],
});
const FETCH_ARCHIVE_DUE_BY_BUCKET = ThreadArchiveDue.select({
	where: [ThreadArchiveDue.where.eq('due_bucket'), ThreadArchiveDue.where.lte('archive_due_at')],
	limit: ARCHIVE_DUE_FETCH_LIMIT,
});

export class ThreadRepository extends IThreadRepository {
	async createThread(row: ChannelRow): Promise<Channel> {
		if (!row.guild_id || !row.parent_id) {
			throw new Error('Thread rows require guild_id and parent_id');
		}
		const batch = new BatchBuilder();
		batch.addPrepared(Threads.insert(row));
		batch.addPrepared(
			ThreadsByParent.insert({
				parent_id: row.parent_id,
				thread_id: row.channel_id,
				archived: row.thread_metadata?.archived ?? false,
			}),
		);
		batch.addPrepared(
			ThreadsByGuild.insert({
				guild_id: row.guild_id,
				thread_id: row.channel_id,
				parent_id: row.parent_id,
				archived: row.thread_metadata?.archived ?? false,
			}),
		);
		await batch.execute();
		return new Channel(row);
	}

	async listThreadRefsByParent(parentId: ChannelID): Promise<Array<ThreadsByParentRow>> {
		return fetchMany<ThreadsByParentRow>(FETCH_THREAD_REFS_BY_PARENT.bind({parent_id: parentId}));
	}

	async listThreadRefsByGuild(guildId: GuildID): Promise<Array<ThreadsByGuildRow>> {
		return fetchMany<ThreadsByGuildRow>(FETCH_THREAD_REFS_BY_GUILD.bind({guild_id: guildId}));
	}

	async setThreadArchivedRefs(thread: Channel, archived: boolean): Promise<void> {
		if (!thread.guildId || !thread.parentId) return;
		const batch = new BatchBuilder();
		batch.addPrepared(
			ThreadsByParent.patchByPk(
				{parent_id: thread.parentId, thread_id: thread.id},
				{archived: Db.set(archived)},
			),
		);
		batch.addPrepared(
			ThreadsByGuild.patchByPk({guild_id: thread.guildId, thread_id: thread.id}, {archived: Db.set(archived)}),
		);
		await batch.execute();
	}

	async addThreadMember(params: {
		threadId: ChannelID;
		guildId: GuildID;
		userId: UserID;
		joinTimestamp: Date;
	}): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(
			ThreadMembers.insert({
				thread_id: params.threadId,
				user_id: params.userId,
				join_timestamp: params.joinTimestamp,
			}),
		);
		batch.addPrepared(
			ThreadMembersByUser.insert({
				user_id: params.userId,
				guild_id: params.guildId,
				thread_id: params.threadId,
				join_timestamp: params.joinTimestamp,
			}),
		);
		await batch.execute();
	}

	async removeThreadMember(params: {threadId: ChannelID; guildId: GuildID; userId: UserID}): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(ThreadMembers.deleteByPk({thread_id: params.threadId, user_id: params.userId}));
		batch.addPrepared(
			ThreadMembersByUser.deleteByPk({
				user_id: params.userId,
				guild_id: params.guildId,
				thread_id: params.threadId,
			}),
		);
		await batch.execute();
	}

	async getThreadMember(threadId: ChannelID, userId: UserID): Promise<ThreadMemberRow | null> {
		return fetchOne<ThreadMemberRow>(FETCH_THREAD_MEMBER.bind({thread_id: threadId, user_id: userId}));
	}

	async listThreadMembers(threadId: ChannelID): Promise<Array<ThreadMemberRow>> {
		return fetchMany<ThreadMemberRow>(FETCH_THREAD_MEMBERS.bind({thread_id: threadId}));
	}

	async listJoinedThreadIds(userId: UserID, guildId: GuildID): Promise<Array<ChannelID>> {
		const rows = await fetchMany<{thread_id: ChannelID}>(
			FETCH_JOINED_THREADS.bind({user_id: userId, guild_id: guildId}),
		);
		return rows.map((row) => row.thread_id);
	}

	async deleteThread(thread: Channel): Promise<void> {
		const members = await this.listThreadMembers(thread.id);
		const batch = new BatchBuilder();
		batch.addPrepared(Threads.deleteByPk({channel_id: thread.id, soft_deleted: false}));
		if (thread.parentId) {
			batch.addPrepared(ThreadsByParent.deleteByPk({parent_id: thread.parentId, thread_id: thread.id}));
		}
		if (thread.guildId) {
			batch.addPrepared(ThreadsByGuild.deleteByPk({guild_id: thread.guildId, thread_id: thread.id}));
		}
		batch.addPrepared(ThreadMembers.deletePartition({thread_id: thread.id}));
		await batch.execute();
		if (thread.guildId) {
			const guildId = thread.guildId;
			await Promise.all(
				members.map((member) =>
					upsertOne(
						ThreadMembersByUser.deleteByPk({
							user_id: member.user_id,
							guild_id: guildId,
							thread_id: thread.id,
						}),
					),
				),
			);
		}
	}

	async upsertArchiveDue(row: ThreadArchiveDueRow): Promise<void> {
		await upsertOne(ThreadArchiveDue.insertWithTtl(row, ARCHIVE_DUE_ROW_TTL_SECONDS));
	}

	async fetchArchiveDueByBucket(bucket: number, dueBefore: Date): Promise<Array<ThreadArchiveDueRow>> {
		return fetchMany<ThreadArchiveDueRow>(
			FETCH_ARCHIVE_DUE_BY_BUCKET.bind({due_bucket: bucket, archive_due_at: dueBefore}),
		);
	}

	async deleteArchiveDueRow(
		row: Pick<ThreadArchiveDueRow, 'due_bucket' | 'archive_due_at' | 'thread_id'>,
	): Promise<void> {
		await upsertOne(
			ThreadArchiveDue.deleteByPk({
				due_bucket: row.due_bucket,
				archive_due_at: row.archive_due_at,
				thread_id: row.thread_id,
			}),
		);
	}
}

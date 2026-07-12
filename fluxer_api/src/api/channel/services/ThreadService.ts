// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ChannelTypes,
	isThreadChannelType,
	MessageTypes,
	Permissions,
	THREAD_AUTO_ARCHIVE_DURATION_DEFAULT,
} from '@fluxer/constants/src/ChannelConstants';
import {MAX_ACTIVE_THREADS_PER_GUILD, THREAD_MEMBER_COUNT_TRACKING_CAP} from '@fluxer/constants/src/LimitConstants';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {MaxActiveThreadsError} from '@fluxer/errors/src/domains/channel/MaxActiveThreadsError';
import {ThreadAlreadyCreatedError} from '@fluxer/errors/src/domains/channel/ThreadAlreadyCreatedError';
import {ThreadArchivedError} from '@fluxer/errors/src/domains/channel/ThreadArchivedError';
import {ThreadLockedError} from '@fluxer/errors/src/domains/channel/ThreadLockedError';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import type {ThreadCreateRequest} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';
import type {ChannelResponse, ThreadMemberResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {ChannelID, MessageID, UserID} from '../../BrandedTypes';
import {createChannelID, createMessageID} from '../../BrandedTypes';
import type {GatewayDispatchEvent} from '../../constants/Gateway';
import type {ThreadMemberRow, ThreadMetadata} from '../../database/types/ChannelTypes';
import type {IGatewayService} from '../../infrastructure/IGatewayService';
import type {ISnowflakeService} from '../../infrastructure/ISnowflakeService';
import type {UserCacheService} from '../../infrastructure/UserCacheService';
import type {RequestCache} from '../../middleware/RequestCacheMiddleware';
import type {Channel} from '../../models/Channel';
import {deleteChannelMessageSearchDocuments} from '../../search/MessageSearchIndexCleanup';
import {mapChannelToResponse} from '../ChannelMappers';
import type {IChannelRepositoryAggregate} from '../repositories/IChannelRepositoryAggregate';
import {getThreadArchiveDueBucket} from '../repositories/ThreadRepository';
import {dispatchChannelEvent} from './ChannelGatewayDispatch';
import type {ChannelAuthService} from './channel_data/ChannelAuthService';
import {dispatchMessageCreateBroadcast} from './message/MessageGatewayDispatch';
import type {MessagePersistenceService} from './message/MessagePersistenceService';

const MINUTE_MS = 60 * 1000;

interface ThreadUpdateData {
	name?: string | null;
	archived?: boolean;
	locked?: boolean;
	auto_archive_duration?: number;
	rate_limit_per_user?: number | null;
}

export interface ThreadListResult {
	threads: Array<ChannelResponse>;
	members: Array<ThreadMemberResponse>;
	hasMore: boolean;
}

function serializeThreadMember(row: ThreadMemberRow): ThreadMemberResponse {
	return {
		id: row.thread_id.toString(),
		user_id: row.user_id.toString(),
		join_timestamp: row.join_timestamp.toISOString(),
	};
}

function threadMetadataOf(channel: Channel): ThreadMetadata {
	return (
		channel.threadMetadata ?? {
			archived: false,
			locked: false,
			auto_archive_duration: THREAD_AUTO_ARCHIVE_DURATION_DEFAULT,
			archive_timestamp: null,
		}
	);
}

function archiveDueAt(from: Date, autoArchiveDurationMinutes: number): Date {
	return new Date(from.getTime() + autoArchiveDurationMinutes * MINUTE_MS);
}

export class ThreadService {
	constructor(
		private readonly channelRepository: IChannelRepositoryAggregate,
		private readonly auth: ChannelAuthService,
		private readonly userCacheService: UserCacheService,
		private readonly gatewayService: IGatewayService,
		private readonly snowflakeService: ISnowflakeService,
		private readonly messagePersistenceService: MessagePersistenceService,
	) {}

	async createThreadFromMessage(params: {
		userId: UserID;
		channelId: ChannelID;
		messageId: MessageID;
		data: ThreadCreateRequest;
		requestCache: RequestCache;
	}): Promise<ChannelResponse> {
		const message = await this.channelRepository.messages.getMessage(params.channelId, params.messageId);
		if (!message) throw new UnknownMessageError();
		const threadId = createChannelID(BigInt(params.messageId));
		const existing = await this.channelRepository.channelData.findUnique(threadId);
		if (existing && isThreadChannelType(existing.type)) {
			throw new ThreadAlreadyCreatedError();
		}
		return this.createThreadInternal({...params, threadId, starterMessageId: params.messageId});
	}

	async createThread(params: {
		userId: UserID;
		channelId: ChannelID;
		data: ThreadCreateRequest;
		requestCache: RequestCache;
	}): Promise<ChannelResponse> {
		const threadId = createChannelID(await this.snowflakeService.generateForChannel(params.channelId));
		return this.createThreadInternal({...params, threadId, starterMessageId: null});
	}

	private async createThreadInternal(params: {
		userId: UserID;
		channelId: ChannelID;
		threadId: ChannelID;
		starterMessageId: MessageID | null;
		data: ThreadCreateRequest;
		requestCache: RequestCache;
	}): Promise<ChannelResponse> {
		const {
			channel: parent,
			guild,
			checkPermission,
		} = await this.auth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.channelId,
		});
		if (!parent.guildId || !guild || parent.type !== ChannelTypes.GUILD_TEXT) {
			throw new InvalidChannelTypeError();
		}
		await checkPermission(Permissions.CREATE_PUBLIC_THREADS);
		const guildRefs = await this.channelRepository.threads.listThreadRefsByGuild(parent.guildId);
		const activeCount = guildRefs.filter((ref) => !ref.archived).length;
		if (activeCount >= MAX_ACTIVE_THREADS_PER_GUILD) {
			throw new MaxActiveThreadsError(MAX_ACTIVE_THREADS_PER_GUILD);
		}
		const now = new Date();
		const autoArchiveDuration = params.data.auto_archive_duration ?? THREAD_AUTO_ARCHIVE_DURATION_DEFAULT;
		const thread = await this.channelRepository.threads.createThread({
			channel_id: params.threadId,
			guild_id: parent.guildId,
			type: ChannelTypes.GUILD_THREAD,
			name: params.data.name,
			topic: null,
			icon_hash: null,
			url: null,
			parent_id: parent.id,
			position: 0,
			owner_id: params.userId,
			recipient_ids: null,
			nsfw: null,
			content_warning_level: 0,
			content_warning_text: null,
			rate_limit_per_user: params.data.rate_limit_per_user ?? 0,
			bitrate: null,
			user_limit: null,
			voice_connection_limit: null,
			rtc_region: null,
			last_message_id: null,
			last_pin_timestamp: null,
			permission_overwrites: null,
			nicks: null,
			soft_deleted: false,
			indexed_at: null,
			version: 0,
			thread_metadata: {
				archived: false,
				locked: false,
				auto_archive_duration: autoArchiveDuration,
				archive_timestamp: null,
			},
			message_count: 0,
			total_message_sent: 0,
			member_count: 1,
		});
		await this.channelRepository.threads.addThreadMember({
			threadId: thread.id,
			guildId: parent.guildId,
			userId: params.userId,
			joinTimestamp: now,
		});
		await this.scheduleArchiveDue(thread, now, autoArchiveDuration);
		if (params.starterMessageId) {
			const starterMessage = await this.messagePersistenceService.createSystemMessage({
				messageId: createMessageID(BigInt(params.starterMessageId)),
				channelId: thread.id,
				userId: params.userId,
				type: MessageTypes.THREAD_STARTER_MESSAGE,
				guildId: parent.guildId,
			});
			await dispatchMessageCreateBroadcast({
				gatewayService: this.gatewayService,
				channel: thread,
				message: starterMessage,
			});
		}
		const threadCreatedMessageId = createMessageID(await this.snowflakeService.generateForChannel(parent.id));
		const threadCreatedMessage = await this.messagePersistenceService.createSystemMessage({
			messageId: threadCreatedMessageId,
			channelId: parent.id,
			userId: params.userId,
			type: MessageTypes.THREAD_CREATED,
			content: params.data.name,
			guildId: parent.guildId,
		});
		await dispatchMessageCreateBroadcast({
			gatewayService: this.gatewayService,
			channel: parent,
			message: threadCreatedMessage,
		});
		const member = await this.channelRepository.threads.getThreadMember(thread.id, params.userId);
		const response = await this.mapThreadResponse(thread, params.userId, params.requestCache, member);
		await this.dispatchThreadEvent(thread, 'THREAD_CREATE', {...response, newly_created: true});
		return response;
	}

	async updateThread(params: {
		userId: UserID;
		threadId: ChannelID;
		data: ThreadUpdateData;
		requestCache: RequestCache;
	}): Promise<ChannelResponse> {
		const {channel: thread, hasPermission} = await this.auth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.threadId,
		});
		if (!isThreadChannelType(thread.type) || !thread.guildId) {
			throw new InvalidChannelTypeError();
		}
		const metadata = threadMetadataOf(thread);
		const isCreator = thread.ownerId === params.userId;
		const canManageThreads = await hasPermission(Permissions.MANAGE_THREADS);
		const wantsUnarchive = params.data.archived === false && metadata.archived;
		const wantsArchive = params.data.archived === true && !metadata.archived;
		if (wantsUnarchive) {
			if (metadata.locked && !canManageThreads) {
				throw new ThreadLockedError();
			}
			if (!canManageThreads) {
				const member = await this.channelRepository.threads.getThreadMember(thread.id, params.userId);
				if (!member) throw new MissingPermissionsError();
			}
		} else if (metadata.archived && !wantsUnarchive) {
			// An archived thread must be unarchived before any other change.
			throw new ThreadArchivedError();
		}
		const changesName = params.data.name !== undefined && params.data.name !== null;
		const changesDuration = params.data.auto_archive_duration !== undefined;
		if ((changesName || changesDuration) && !isCreator && !canManageThreads) {
			throw new MissingPermissionsError();
		}
		if (params.data.locked !== undefined && params.data.locked !== metadata.locked && !canManageThreads) {
			throw new MissingPermissionsError();
		}
		if (params.data.rate_limit_per_user !== undefined && !canManageThreads) {
			throw new MissingPermissionsError();
		}
		if (wantsArchive && !isCreator && !canManageThreads) {
			throw new MissingPermissionsError();
		}
		const now = new Date();
		const nextMetadata: ThreadMetadata = {
			archived: params.data.archived ?? metadata.archived,
			locked: params.data.locked ?? metadata.locked,
			auto_archive_duration: params.data.auto_archive_duration ?? metadata.auto_archive_duration,
			archive_timestamp: wantsArchive || wantsUnarchive ? now : (metadata.archive_timestamp ?? null),
		};
		const row = thread.toRow();
		const previousName = thread.name;
		if (changesName) row.name = params.data.name ?? thread.name;
		if (params.data.rate_limit_per_user !== undefined) {
			row.rate_limit_per_user = params.data.rate_limit_per_user ?? 0;
		}
		row.thread_metadata = nextMetadata;
		const updated = await this.channelRepository.channelData.upsert(row);
		if (wantsArchive || wantsUnarchive) {
			await this.channelRepository.threads.setThreadArchivedRefs(updated, nextMetadata.archived);
		}
		if (!nextMetadata.archived && (wantsUnarchive || changesDuration)) {
			await this.scheduleArchiveDue(updated, now, nextMetadata.auto_archive_duration);
		}
		if (changesName && previousName !== row.name) {
			const messageId = createMessageID(await this.snowflakeService.generateForChannel(updated.id));
			const systemMessage = await this.messagePersistenceService.createSystemMessage({
				messageId,
				channelId: updated.id,
				userId: params.userId,
				type: MessageTypes.CHANNEL_NAME_CHANGE,
				content: row.name,
				guildId: updated.guildId,
			});
			await dispatchMessageCreateBroadcast({
				gatewayService: this.gatewayService,
				channel: updated,
				message: systemMessage,
			});
		}
		const member = await this.channelRepository.threads.getThreadMember(updated.id, params.userId);
		const response = await this.mapThreadResponse(updated, params.userId, params.requestCache, member);
		await this.dispatchThreadEvent(updated, 'THREAD_UPDATE', response);
		return response;
	}

	async joinThread(params: {userId: UserID; threadId: ChannelID; requestCache: RequestCache}): Promise<void> {
		await this.addThreadMemberInternal({
			actorId: params.userId,
			targetId: params.userId,
			threadId: params.threadId,
			withSystemMessage: true,
		});
	}

	async addThreadMember(params: {userId: UserID; threadId: ChannelID; targetId: UserID}): Promise<void> {
		await this.addThreadMemberInternal({
			actorId: params.userId,
			targetId: params.targetId,
			threadId: params.threadId,
			withSystemMessage: true,
		});
	}

	private async addThreadMemberInternal(params: {
		actorId: UserID;
		targetId: UserID;
		threadId: ChannelID;
		withSystemMessage: boolean;
	}): Promise<void> {
		const {channel: thread} = await this.auth.getChannelAuthenticated({
			userId: params.actorId,
			channelId: params.threadId,
		});
		if (!isThreadChannelType(thread.type) || !thread.guildId) {
			throw new InvalidChannelTypeError();
		}
		const metadata = threadMetadataOf(thread);
		if (metadata.archived) throw new ThreadArchivedError();
		const existing = await this.channelRepository.threads.getThreadMember(thread.id, params.targetId);
		if (existing) return;
		const joinTimestamp = new Date();
		await this.channelRepository.threads.addThreadMember({
			threadId: thread.id,
			guildId: thread.guildId,
			userId: params.targetId,
			joinTimestamp,
		});
		await this.bumpMemberCount(thread, 1);
		if (params.withSystemMessage) {
			const messageId = createMessageID(await this.snowflakeService.generateForChannel(thread.id));
			const systemMessage = await this.messagePersistenceService.createSystemMessage({
				messageId,
				channelId: thread.id,
				userId: params.actorId,
				type: MessageTypes.RECIPIENT_ADD,
				guildId: thread.guildId,
				mentionUserIds: [params.targetId],
			});
			await dispatchMessageCreateBroadcast({
				gatewayService: this.gatewayService,
				channel: thread,
				message: systemMessage,
			});
		}
		await this.dispatchThreadMembersUpdate(thread, {
			addedMembers: [{thread_id: thread.id, user_id: params.targetId, join_timestamp: joinTimestamp}],
			removedMemberIds: [],
		});
	}

	async leaveThread(params: {userId: UserID; threadId: ChannelID}): Promise<void> {
		await this.removeThreadMemberInternal({actorId: params.userId, targetId: params.userId, threadId: params.threadId});
	}

	async removeThreadMember(params: {userId: UserID; threadId: ChannelID; targetId: UserID}): Promise<void> {
		await this.removeThreadMemberInternal({
			actorId: params.userId,
			targetId: params.targetId,
			threadId: params.threadId,
		});
	}

	private async removeThreadMemberInternal(params: {
		actorId: UserID;
		targetId: UserID;
		threadId: ChannelID;
	}): Promise<void> {
		const {channel: thread, checkPermission} = await this.auth.getChannelAuthenticated({
			userId: params.actorId,
			channelId: params.threadId,
		});
		if (!isThreadChannelType(thread.type) || !thread.guildId) {
			throw new InvalidChannelTypeError();
		}
		if (params.actorId !== params.targetId) {
			await checkPermission(Permissions.MANAGE_THREADS);
		}
		const existing = await this.channelRepository.threads.getThreadMember(thread.id, params.targetId);
		if (!existing) return;
		await this.channelRepository.threads.removeThreadMember({
			threadId: thread.id,
			guildId: thread.guildId,
			userId: params.targetId,
		});
		await this.bumpMemberCount(thread, -1);
		const messageId = createMessageID(await this.snowflakeService.generateForChannel(thread.id));
		const systemMessage = await this.messagePersistenceService.createSystemMessage({
			messageId,
			channelId: thread.id,
			userId: params.actorId,
			type: MessageTypes.RECIPIENT_REMOVE,
			guildId: thread.guildId,
			mentionUserIds: [params.targetId],
		});
		await dispatchMessageCreateBroadcast({
			gatewayService: this.gatewayService,
			channel: thread,
			message: systemMessage,
		});
		await this.dispatchThreadMembersUpdate(thread, {
			addedMembers: [],
			removedMemberIds: [params.targetId],
		});
	}

	async listThreadMembers(params: {userId: UserID; threadId: ChannelID}): Promise<Array<ThreadMemberResponse>> {
		const {channel: thread} = await this.auth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.threadId,
		});
		if (!isThreadChannelType(thread.type)) throw new InvalidChannelTypeError();
		const members = await this.channelRepository.threads.listThreadMembers(thread.id);
		return members.map(serializeThreadMember);
	}

	async listActiveThreads(params: {
		userId: UserID;
		channelId: ChannelID;
		requestCache: RequestCache;
	}): Promise<ThreadListResult> {
		const {channel: parent} = await this.auth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.channelId,
		});
		const refs = await this.channelRepository.threads.listThreadRefsByParent(parent.id);
		const activeIds = refs.filter((ref) => !ref.archived).map((ref) => ref.thread_id);
		const threads = await this.channelRepository.channelData.listChannels(activeIds);
		threads.sort((a, b) => (a.id < b.id ? -1 : 1));
		return this.buildThreadListResult(threads, params.userId, params.requestCache, false);
	}

	async listArchivedThreads(params: {
		userId: UserID;
		channelId: ChannelID;
		before?: string;
		limit?: number;
		requestCache: RequestCache;
	}): Promise<ThreadListResult> {
		const {channel: parent} = await this.auth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.channelId,
		});
		const refs = await this.channelRepository.threads.listThreadRefsByParent(parent.id);
		const archivedIds = refs.filter((ref) => ref.archived === true).map((ref) => ref.thread_id);
		const limit = params.limit ?? 50;
		const beforeTime = params.before ? new Date(params.before).getTime() : Number.POSITIVE_INFINITY;
		const threads = (await this.channelRepository.channelData.listChannels(archivedIds))
			.filter((thread) => {
				const archivedAt = thread.threadMetadata?.archive_timestamp?.getTime() ?? 0;
				return archivedAt < beforeTime;
			})
			.sort((a, b) => {
				const aTime = a.threadMetadata?.archive_timestamp?.getTime() ?? 0;
				const bTime = b.threadMetadata?.archive_timestamp?.getTime() ?? 0;
				return bTime - aTime;
			});
		const page = threads.slice(0, limit);
		return this.buildThreadListResult(page, params.userId, params.requestCache, threads.length > limit);
	}

	async searchThreads(params: {
		userId: UserID;
		channelId: ChannelID;
		query?: string;
		includeArchived?: boolean;
		limit?: number;
		requestCache: RequestCache;
	}): Promise<ThreadListResult> {
		const {channel: parent} = await this.auth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.channelId,
		});
		const refs = await this.channelRepository.threads.listThreadRefsByParent(parent.id);
		const ids = refs.filter((ref) => params.includeArchived || !ref.archived).map((ref) => ref.thread_id);
		const needle = params.query?.toLowerCase();
		const limit = params.limit ?? 25;
		const threads = (await this.channelRepository.channelData.listChannels(ids))
			.filter((thread) => !needle || (thread.name ?? '').toLowerCase().includes(needle))
			.sort((a, b) => {
				const aLast = a.lastMessageId ?? a.id;
				const bLast = b.lastMessageId ?? b.id;
				return aLast < bLast ? 1 : -1;
			});
		const page = threads.slice(0, limit);
		return this.buildThreadListResult(page, params.userId, params.requestCache, threads.length > limit);
	}

	async deleteThread(params: {userId: UserID; threadId: ChannelID; requestCache: RequestCache}): Promise<void> {
		const {channel: thread, checkPermission} = await this.auth.getChannelAuthenticated({
			userId: params.userId,
			channelId: params.threadId,
		});
		if (!isThreadChannelType(thread.type) || !thread.guildId) {
			throw new InvalidChannelTypeError();
		}
		await checkPermission(Permissions.MANAGE_THREADS);
		await this.channelRepository.messages.deleteAllChannelMessages(thread.id);
		await deleteChannelMessageSearchDocuments(thread.id, {context: {source: 'thread_delete'}});
		await this.channelRepository.threads.deleteThread(thread);
		await this.dispatchThreadEvent(thread, 'THREAD_DELETE', {
			id: thread.id.toString(),
			guild_id: thread.guildId.toString(),
			parent_id: thread.parentId ? thread.parentId.toString() : null,
			type: thread.type,
		});
	}

	/**
	 * Message-send integration: keeps counts fresh, resets the auto-archive timer,
	 * auto-unarchives on activity, and auto-joins the sender plus mentioned users.
	 */
	async handleThreadMessageSent(params: {
		thread: Channel;
		senderId: UserID;
		mentionedUserIds: Array<UserID>;
	}): Promise<void> {
		const thread = params.thread;
		if (!isThreadChannelType(thread.type) || !thread.guildId) return;
		const metadata = threadMetadataOf(thread);
		const now = new Date();
		const row = thread.toRow();
		row.message_count = (thread.messageCount ?? 0) + 1;
		row.total_message_sent = (thread.totalMessageSent ?? 0) + 1;
		let unarchived = false;
		if (metadata.archived && !metadata.locked) {
			row.thread_metadata = {...metadata, archived: false, archive_timestamp: now};
			unarchived = true;
		}
		const updated = await this.channelRepository.channelData.upsert(row);
		if (unarchived) {
			await this.channelRepository.threads.setThreadArchivedRefs(updated, false);
		}
		await this.scheduleArchiveDue(updated, now, metadata.auto_archive_duration);
		const joiners = [params.senderId, ...params.mentionedUserIds];
		const added: Array<ThreadMemberRow> = [];
		for (const userId of joiners) {
			const existing = await this.channelRepository.threads.getThreadMember(thread.id, userId);
			if (existing) continue;
			const joinTimestamp = new Date();
			await this.channelRepository.threads.addThreadMember({
				threadId: thread.id,
				guildId: thread.guildId,
				userId,
				joinTimestamp,
			});
			added.push({thread_id: thread.id, user_id: userId, join_timestamp: joinTimestamp});
		}
		if (added.length > 0) {
			await this.bumpMemberCount(updated, added.length);
			await this.dispatchThreadMembersUpdate(updated, {addedMembers: added, removedMemberIds: []});
		}
		if (unarchived) {
			const response = await this.mapThreadResponse(updated, null, null, null);
			await this.dispatchThreadEvent(updated, 'THREAD_UPDATE', response);
		}
	}

	/** Archives a thread on behalf of the auto-archive sweep. */
	async archiveThreadBySystem(thread: Channel): Promise<void> {
		const metadata = threadMetadataOf(thread);
		if (metadata.archived) return;
		const now = new Date();
		const row = thread.toRow();
		row.thread_metadata = {...metadata, archived: true, archive_timestamp: now};
		const updated = await this.channelRepository.channelData.upsert(row);
		await this.channelRepository.threads.setThreadArchivedRefs(updated, true);
		const response = await this.mapThreadResponse(updated, null, null, null);
		await this.dispatchThreadEvent(updated, 'THREAD_UPDATE', response);
	}

	private async scheduleArchiveDue(thread: Channel, from: Date, autoArchiveDurationMinutes: number): Promise<void> {
		if (!thread.guildId) return;
		const dueAt = archiveDueAt(from, autoArchiveDurationMinutes);
		await this.channelRepository.threads.upsertArchiveDue({
			due_bucket: getThreadArchiveDueBucket(dueAt),
			archive_due_at: dueAt,
			thread_id: thread.id,
			guild_id: thread.guildId,
			parent_id: thread.parentId,
		});
	}

	private async bumpMemberCount(thread: Channel, delta: number): Promise<void> {
		const current = thread.memberCount ?? 0;
		if (delta > 0 && current >= THREAD_MEMBER_COUNT_TRACKING_CAP) return;
		const next = Math.max(0, Math.min(THREAD_MEMBER_COUNT_TRACKING_CAP, current + delta));
		if (next === current) return;
		const row = thread.toRow();
		row.member_count = next;
		await this.channelRepository.channelData.upsert(row);
	}

	private async buildThreadListResult(
		threads: Array<Channel>,
		userId: UserID,
		requestCache: RequestCache,
		hasMore: boolean,
	): Promise<ThreadListResult> {
		const responses: Array<ChannelResponse> = [];
		const members: Array<ThreadMemberResponse> = [];
		for (const thread of threads) {
			const member = await this.channelRepository.threads.getThreadMember(thread.id, userId);
			responses.push(await this.mapThreadResponse(thread, userId, requestCache, member));
			if (member) members.push(serializeThreadMember(member));
		}
		return {threads: responses, members, hasMore};
	}

	private async mapThreadResponse(
		thread: Channel,
		userId: UserID | null,
		requestCache: RequestCache | null,
		member: ThreadMemberRow | null,
	): Promise<ChannelResponse> {
		const response = await mapChannelToResponse({
			channel: thread,
			currentUserId: userId,
			userCacheService: this.userCacheService,
			requestCache: requestCache ?? ({} as RequestCache),
		});
		if (member) {
			return {...response, member: serializeThreadMember(member)};
		}
		return response;
	}

	private async dispatchThreadEvent(thread: Channel, event: GatewayDispatchEvent, data: unknown): Promise<void> {
		await dispatchChannelEvent({
			gatewayService: this.gatewayService,
			channel: thread,
			event,
			data,
		});
	}

	private async dispatchThreadMembersUpdate(
		thread: Channel,
		params: {addedMembers: Array<ThreadMemberRow>; removedMemberIds: Array<UserID>},
	): Promise<void> {
		if (!thread.guildId) return;
		await this.dispatchThreadEvent(thread, 'THREAD_MEMBERS_UPDATE', {
			id: thread.id.toString(),
			guild_id: thread.guildId.toString(),
			member_count: Math.min((thread.memberCount ?? 0) + params.addedMembers.length, THREAD_MEMBER_COUNT_TRACKING_CAP),
			added_members: params.addedMembers.map(serializeThreadMember),
			removed_member_ids: params.removedMemberIds.map((id) => id.toString()),
		});
		for (const added of params.addedMembers) {
			await this.gatewayService.dispatchPresence({
				userId: added.user_id,
				event: 'THREAD_MEMBER_UPDATE',
				data: serializeThreadMember(added),
			});
		}
		for (const removedId of params.removedMemberIds) {
			await this.gatewayService.dispatchPresence({
				userId: removedId,
				event: 'THREAD_MEMBER_UPDATE',
				data: {id: thread.id.toString(), user_id: removedId.toString(), join_timestamp: null},
			});
		}
	}
}

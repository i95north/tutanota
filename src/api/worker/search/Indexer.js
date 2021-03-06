//@flow
import type {GroupTypeEnum} from "../../common/TutanotaConstants"
import {NOTHING_INDEXED_TIMESTAMP, GroupType, OperationType, MailState} from "../../common/TutanotaConstants"
import {load, loadAll, loadRange, EntityWorker} from "../EntityWorker"
import {NotAuthorizedError, NotFoundError} from "../../common/error/RestError"
import {EntityEventBatchTypeRef} from "../../entities/sys/EntityEventBatch"
import type {DbTransaction} from "./DbFacade"
import {DbFacade, MetaDataOS, GroupDataOS} from "./DbFacade"
import {GENERATED_MAX_ID, isSameTypeRef, TypeRef, isSameId} from "../../common/EntityFunctions"
import {neverNull} from "../../common/utils/Utils"
import {hash} from "../crypto/Sha256"
import {uint8ArrayToBase64, stringToUtf8Uint8Array} from "../../common/utils/Encoding"
import {aes256RandomKey} from "../crypto/Aes"
import {encrypt256Key, decrypt256Key} from "../crypto/CryptoFacade"
import {userIsAdmin, filterMailMemberships, filterIndexMemberships} from "./IndexUtils"
import type {Db, GroupData} from "./SearchTypes"
import {_createNewIndexUpdate} from "./SearchTypes"
import type {WorkerImpl} from "../WorkerImpl"
import {ContactIndexer} from "./ContactIndexer"
import {MailTypeRef} from "../../entities/tutanota/Mail"
import {ContactTypeRef} from "../../entities/tutanota/Contact"
import {GroupInfoTypeRef} from "../../entities/sys/GroupInfo"
import {UserTypeRef} from "../../entities/sys/User"
import {GroupInfoIndexer} from "./GroupInfoIndexer"
import {MailIndexer} from "./MailIndexer"
import {IndexerCore} from "./IndexerCore"
import type {EntityRestClient} from "../rest/EntityRestClient"

export const Metadata = {
	userEncDbKey: "userEncDbKey",
	mailIndexingEnabled: "mailIndexingEnabled",
	excludedListIds: "excludedListIds"
}

export type InitParams = {
	user: User;
	groupKey: Aes128Key;
}


/**
 * FIXME Write noop ENTITY_EVENT_BATCH on the server every twenty days (not once a month because of months with 31 days) to prevent
 * OutOfSync errors one of the groups of a user has not received a single update (e.g. contacts not updated within last month).
 * The noop ENTITY_EVENT_BATCH must be written for each area group.
 */
export class Indexer {
	db: Db;

	_worker: WorkerImpl;

	_initParams: InitParams;

	_contact: ContactIndexer;
	_mail: MailIndexer;
	_groupInfo: GroupInfoIndexer;
	_core: IndexerCore;

	constructor(entityRestClient: EntityRestClient, worker: WorkerImpl) {
		this.db = ({}:any) // correctly initialized during init()
		this._worker = worker
		this._core = new IndexerCore(this.db)
		let entity = new EntityWorker()
		this._contact = new ContactIndexer(this._core, this.db, entity)
		this._mail = new MailIndexer(this._core, this.db, entity, worker, entityRestClient)
		this._groupInfo = new GroupInfoIndexer(this._core, this.db, entity)
	}

	/**
	 * Opens a new DbFacade and initializes the metadata if it is not there yet
	 */
	init(user: User, userGroupKey: Aes128Key) {
		this._initParams = {
			user,
			groupKey: userGroupKey,
		}
		return new DbFacade().open(uint8ArrayToBase64(hash(stringToUtf8Uint8Array(user._id)))).then(facade => {
			self.dbFacade = facade
			this.db.dbFacade = facade
			let dbInit = (): Promise<void> => {
				let t = this.db.dbFacade.createTransaction(true, [MetaDataOS])
				return t.get(MetaDataOS, Metadata.userEncDbKey).then(userEncDbKey => {
					if (!userEncDbKey) {
						return this._loadGroupData(user).then((groupBatches: {groupId: Id, groupData: GroupData}[]) => {
							let t2 = this.db.dbFacade.createTransaction(false, [MetaDataOS, GroupDataOS])
							this.db.key = aes256RandomKey()
							t2.put(MetaDataOS, Metadata.userEncDbKey, encrypt256Key(userGroupKey, this.db.key))
							t2.put(MetaDataOS, Metadata.mailIndexingEnabled, this._mail.mailIndexingEnabled)
							return this._initGroupData(groupBatches, t2)
						})
					} else {
						this.db.key = decrypt256Key(userGroupKey, userEncDbKey)
						return Promise.all([
							t.get(MetaDataOS, Metadata.mailIndexingEnabled).then(mailIndexingEnabled => {
								this._mail.mailIndexingEnabled = mailIndexingEnabled
							}),
							t.get(MetaDataOS, Metadata.excludedListIds).then(excludedListIds => {
								this._mail._excludedListIds = excludedListIds
							}),
							this._updateGroups(user, this._groupDiff(user)).then(() => this._mail.updateCurrentIndexTimestamp(user)),
						]).return()
					}
				})
			}
			return dbInit().then(() => {
				this._worker.sendIndexState({
					mailIndexEnabled: this._mail.mailIndexingEnabled,
					progress: 0,
					currentIndexTimestamp: this._mail.currentIndexTimestamp
				})
				return this._contact.indexFullContactList(user.userGroup.group)
					.then(() => this._groupInfo.indexAllUserAndTeamGroupInfosForAdmin(user))
					.then(() => this._loadNewEntities(user))
			})
		})
	}

	enableMailIndexing(): Promise<void> {
		return this._mail.enableMailIndexing(this._initParams.user)
	}

	disableMailIndexing(): Promise<void> {
		return this._mail.disableMailIndexing().then(() => {
			return this.init(this._initParams.user, this._initParams.groupKey)
		})
	}

	cancelMailIndexing(): Promise<void> {
		return this._mail.cancelMailIndexing()
	}

	processEntityEvents(events: EntityUpdate[], groupId: Id, batchId: Id): Promise<void> {
		let indexUpdate = _createNewIndexUpdate(groupId)
		indexUpdate.batchId = [groupId, batchId]
		return Promise.each(events, (event, index) => {
			if (isSameTypeRef(new TypeRef(event.application, event.type), MailTypeRef) && this._mail.mailIndexingEnabled) {
				if (event.operation == OperationType.CREATE) {
					if (containsEventOfType(events, OperationType.DELETE, event.instanceId)) {
						// move mail
						return this._mail.processMovedMail(event, indexUpdate)
					} else {
						// new mail
						return this._mail.processNewMail(event).then((result) => {
							if (result) {
								this._core.encryptSearchIndexEntries(result.mail._id, neverNull(result.mail._ownerGroup), result.keyToIndexEntries, indexUpdate)
							}
						})
					}
				} else if (event.operation == OperationType.UPDATE) {
					return load(MailTypeRef, [event.instanceListId, event.instanceId]).then(mail => {
						if (mail.state == MailState.DRAFT) {
							return Promise.all([
								this._core._processDeleted(event, indexUpdate),
								this._mail.processNewMail(event).then(result => {
									if (result) {
										this._core.encryptSearchIndexEntries(result.mail._id, neverNull(result.mail._ownerGroup), result.keyToIndexEntries, indexUpdate)
									}
								})
							])
						}
					}).catch(NotFoundError, () => console.log("tried to index update event for non existing mail"))
				} else if (event.operation == OperationType.DELETE) {
					if (!containsEventOfType(events, OperationType.CREATE, event.instanceId)) { // move events are handled separately
						return this._core._processDeleted(event, indexUpdate)
					}
				}
			} else if (isSameTypeRef(new TypeRef(event.application, event.type), ContactTypeRef)) {
				if (event.operation == OperationType.CREATE) {
					this._contact.processNewContact(event).then(result => {
						if (result) this._core.encryptSearchIndexEntries(result.contact._id, neverNull(result.contact._ownerGroup), result.keyToIndexEntries, indexUpdate)
					})
				} else if (event.operation == OperationType.UPDATE) {
					return Promise.all([
						this._core._processDeleted(event, indexUpdate),
						this._contact.processNewContact(event).then(result => {
							if (result) this._core.encryptSearchIndexEntries(result.contact._id, neverNull(result.contact._ownerGroup), result.keyToIndexEntries, indexUpdate)
						})
					])
				} else if (event.operation == OperationType.DELETE) {
					return this._core._processDeleted(event, indexUpdate)
				}
			} else if (isSameTypeRef(new TypeRef(event.application, event.type), GroupInfoTypeRef) && userIsAdmin(this._initParams.user)) {
				if (event.operation == OperationType.CREATE) {
					return this._groupInfo.processNewGroupInfo(event).then(result => {
						if (result) this._core.encryptSearchIndexEntries(result.groupInfo._id, neverNull(result.groupInfo._ownerGroup), result.keyToIndexEntries, indexUpdate)
					})
				} else if (event.operation == OperationType.UPDATE) {
					return Promise.all([
						this._core._processDeleted(event, indexUpdate),
						this._groupInfo.processNewGroupInfo(event).then(result => {
							if (result) this._core.encryptSearchIndexEntries(result.groupInfo._id, neverNull(result.groupInfo._ownerGroup), result.keyToIndexEntries, indexUpdate)
						})
					])
				} else if (event.operation == OperationType.DELETE) {
					return this._core._processDeleted(event, indexUpdate)
				}
			} else if (event.operation == OperationType.UPDATE && isSameTypeRef(new TypeRef(event.application, event.type), UserTypeRef) && isSameId(this._initParams.user._id, event.instanceId)) {
				return load(UserTypeRef, event.instanceId).then(updatedUser => {
					let promises = []
					let oldMailGroupMemberships = filterMailMemberships(this._initParams.user)
					let newMailGroupMemberships = filterMailMemberships(updatedUser)
					if (oldMailGroupMemberships.length < newMailGroupMemberships.length) {
						promises.push(this._updateGroups(this._initParams.user, this._groupDiff(this._initParams.user)))
					}
					if (!userIsAdmin(this._initParams.user) && userIsAdmin(updatedUser)) {
						promises.push(this._groupInfo.indexAllUserAndTeamGroupInfosForAdmin(updatedUser))
					}
					this._initParams.user = updatedUser
					return promises
				})
			}
		}).then(() => {
			if (filterIndexMemberships(this._initParams.user).map(m => m.group).indexOf(groupId) != -1) {
				return this._core.writeIndexUpdate(indexUpdate)
			} else {
				console.log("not indexed group", groupId)
			}
		})
	}


	/**
	 * creates the initial group data for all provided group ids
	 */
	_initGroupData(groupBatches: {groupId: Id, groupData: GroupData}[], t2: DbTransaction): Promise<void> {
		groupBatches.forEach(groupIdToLastBatchId => {
			t2.put(GroupDataOS, groupIdToLastBatchId.groupId, groupIdToLastBatchId.groupData)
		})
		return t2.await()
	}

	_groupDiff(user: User): Promise<{deletedGroups: {id: Id, type: GroupTypeEnum}[], newGroups: {id: Id, type: GroupTypeEnum}[]}> {
		let currentGroups = filterIndexMemberships(user).map(m => {
			return {id: m.group, type: neverNull(m.groupType)}
		})
		let t = this.db.dbFacade.createTransaction(true, [GroupDataOS])
		return t.getAllKeys(GroupDataOS).then((oldGroupIds: Id[]) => {
			let deletedGroupIds = oldGroupIds.filter(oldGroupId => currentGroups.find(m => m.id == oldGroupId) == null)
			let newGroups = currentGroups.filter(m => oldGroupIds.find(oldGroupId => m.id == oldGroupId) == null)
			return Promise.map(deletedGroupIds, groupId => t.get(GroupDataOS, groupId).then((groupData: GroupData) => {
				return {id: groupId, type: groupData.groupType}
			})).then(deletedGroups => {
				return {deletedGroups, newGroups}
			})
		})
	}

	_updateGroups(user: User, groupDiff: Promise<{deletedGroups: {id: Id, type: GroupTypeEnum}[], newGroups: {id: Id, type: GroupTypeEnum}[]}>): Promise<void> {
		return groupDiff.then(groupDiff => {
			if (groupDiff.deletedGroups.filter(g => g.type === GroupType.Mail || g.type === GroupType.Contact).length > 0) {
				return this.disableMailIndexing()
			} else if (groupDiff.newGroups.length > 0) {
				return this._loadGroupData(user).then((groupBatches: {groupId: Id, groupData: GroupData}[]) => {
					let t = this.db.dbFacade.createTransaction(false, [GroupDataOS])
					return this._initGroupData(groupBatches, t).then(() => {
						let newMailGroups = groupDiff.newGroups.filter(g => g.type === GroupType.Mail)
						if (newMailGroups.length > 0 && this._mail.mailIndexingEnabled) {
							this._mail.mailboxIndexingPromise.then(() => this._mail.indexMailbox(user, this._mail.currentIndexTimestamp)) // FIXME move to MailIndexer?
						}
					})
				})
			}
		})
	}

	_loadGroupData(user: User): Promise<{groupId: Id, groupData: GroupData}[]> {
		let memberships = filterIndexMemberships(user)
		return Promise.map(memberships, (membership: GroupMembership) => {
			return loadRange(EntityEventBatchTypeRef, membership.group, GENERATED_MAX_ID, 100, true).then(eventBatches => {
				return {
					groupId: membership.group,
					groupData: {
						lastBatchIds: eventBatches.map(eventBatch => eventBatch._id[1]),
						indexTimestamp: NOTHING_INDEXED_TIMESTAMP,
						excludedListIds: [],
						groupType: membership.groupType
					}
				}
			})
		}).catch(NotAuthorizedError, e => {
			console.log("could not download entity updates => lost permission on list")
			return []
		})
	}

	_loadNewEntities(user: User): Promise<void> {
		let t = this.db.dbFacade.createTransaction(true, [GroupDataOS])
		let groupIdToEventBatches: {groupId:Id, eventBatchIds:Id[]}[] = []
		filterIndexMemberships(user).forEach(membership => {
			return t.get(GroupDataOS, membership.group).then(groupData => {
				groupIdToEventBatches.push({
					groupId: membership.group,
					eventBatchIds: groupData.lastBatchIds
				})
			})
		})
		return t.await().then(() => {
			return Promise.map(groupIdToEventBatches, (groupIdToEventBatch) => {
				if (groupIdToEventBatch.eventBatchIds.length > 0) {
					let startId = groupIdToEventBatch.eventBatchIds[groupIdToEventBatch.eventBatchIds.length - 1] // start from lowest id
					return loadAll(EntityEventBatchTypeRef, groupIdToEventBatch.groupId, startId).then(eventBatches => {
						return Promise.map(eventBatches, batch => {
							if (groupIdToEventBatch.eventBatchIds.indexOf(batch._id[1]) == -1) {
								return this.processEntityEvents(batch.events, groupIdToEventBatch.groupId, batch._id[1])
							}
						}, {concurrency: 5})
					}).catch(NotAuthorizedError, e => {
						console.log("could not download entity updates => lost permission on list")
					})
				}
			}, {concurrency: 1})
		}).return()
	}

}

function containsEventOfType(events: EntityUpdate[], type: OperationTypeEnum, elementId: Id): boolean {
	return events.filter(event => event.operation == type && event.instanceId == elementId).length > 0 ? true : false
}



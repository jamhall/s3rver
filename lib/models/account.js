'use strict';

// basic in-memory storage abstraction for accounts and AWS credential key pairs

class Account {
  constructor(id, displayName) {
    Object.assign(this, { id, displayName });
    this.secretAccessKeys = new Map();
  }

  assignKeyPair(accessKeyId, secretAccessKey) {
    this.secretAccessKeys.set(accessKeyId, secretAccessKey);
  }

  getSecretAccessKey(accessKeyId) {
    return this.secretAccessKeys.get(accessKeyId);
  }

  deleteKeyPair(accessKeyId) {
    this.secretAccessKeys.delete(accessKeyId);
  }
}

class AccountStore {
  constructor() {
    // track accounts by both account id and access key id
    this.accountsById = new Map();
    this.accountsByAccessKeyId = new Map();
  }

  addAccount(accountId, displayName) {
    const account = new Account(accountId, displayName);
    this.accountsById.set(accountId, account);
  }

  addKeyPair(accountId, accessKeyId, secretAccessKey) {
    const account = this.accountsById.get(accountId);
    account.assignKeyPair(accessKeyId, secretAccessKey);
    this.accountsByAccessKeyId.set(accessKeyId, account);
  }

  revokeKeyPair(accessKeyId) {
    const account = this.accountsByAccessKeyId.get(accessKeyId);
    account.deleteKeyPair(accessKeyId);
    this.accountsByAccessKeyId.delete(accessKeyId);
  }

  getByAccessKeyId(accessKeyId) {
    return this.accountsByAccessKeyId.get(accessKeyId);
  }

  removeAccount(accountId) {
    const account = this.accountsById.get(accountId);
    const accessKeyIds = [...account.secretAccessKeys.keys()];
    accessKeyIds.forEach((accessKeyId) => this.revokeKeyPair(accessKeyId));
    this.accountsById.delete(accountId);
  }
}

module.exports = AccountStore;

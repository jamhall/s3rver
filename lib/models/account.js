'use strict';

class AWSAccount {
  constructor(accountId, displayName) {
    this.id = accountId;
    this.displayName = displayName;
    this.accessKeys = new Map();
  }

  createKeyPair(accessKeyId, secretAccessKey) {
    AWSAccount.registry.set(accessKeyId, this);
    this.accessKeys.set(accessKeyId, secretAccessKey);
  }

  revokeAccessKey(accessKeyId) {
    AWSAccount.registry.delete(accessKeyId);
    this.accessKeys.delete(accessKeyId);
  }
}
AWSAccount.registry = new Map();

exports = module.exports = AWSAccount;

const accessKeyId = process.env.S3RVER_ACCESS_KEY_ID || 'S3RVER';
const secretAccessKey = process.env.S3RVER_SECRET_ACCESS_KEY || 'S3RVER';

// Hardcoded dummy user used for authenticated requests
exports.DUMMY_ACCOUNT = new AWSAccount(123456789000, 'S3rver');
exports.DUMMY_ACCOUNT.createKeyPair(accessKeyId, secretAccessKey);

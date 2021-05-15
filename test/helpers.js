'use strict';

const AWS = require('aws-sdk');
const { RequestSigner } = require('aws4');
const crypto = require('crypto');
const xmlParser = require('fast-xml-parser');
const fs = require('fs');
const he = require('he');
const { times } = require('lodash');
const os = require('os');
const path = require('path');
const pMap = require('p-map');

const S3rver = require('..');

const tmpDir = path.join(os.tmpdir(), 's3rver_test');

const instances = new Set();

exports.resetTmpDir = function resetTmpDir() {
  try {
    fs.rmdirSync(tmpDir, { recursive: true });
  } catch (err) {
    /* directory didn't exist */
  }
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }
};

exports.generateTestObjects = function generateTestObjects(
  s3Client,
  bucket,
  amount,
) {
  const padding = amount.toString().length;
  const objects = times(amount, (i) => ({
    Bucket: bucket,
    Key: 'key' + i.toString().padStart(padding, '0'),
    Body: 'Hello!',
  }));

  return pMap(objects, (object) => s3Client.putObject(object).promise(), {
    concurrency: 100,
  });
};

exports.md5 = (data) => crypto.createHash('md5').update(data).digest('hex');

exports.parseXml = (data) =>
  xmlParser.parse(data, {
    tagValueProcessor: (a) => he.decode(a),
  });

exports.createServerAndClient = async function createServerAndClient(options) {
  const s3rver = new S3rver(options);
  const { port } = await s3rver.run();
  instances.add(s3rver);

  const s3Client = new AWS.S3({
    accessKeyId: 'S3RVER',
    secretAccessKey: 'S3RVER',
    endpoint: `localhost:${port}`,
    sslEnabled: false,
    s3ForcePathStyle: true,
    signatureVersion: 'v4',
  });

  return { s3rver, s3Client };
};

exports.instances = instances;

exports.StreamingRequestSigner = class extends RequestSigner {
  prepareRequest() {
    this.request.headers['X-Amz-Content-Sha256'] =
      'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
    return super.prepareRequest();
  }

  signature() {
    this.previousSignature = super.signature();
    this.chunkData = undefined;
    return this.previousSignature;
  }

  signChunk(chunkData) {
    this.chunkData = chunkData;
    const chunkLengthHex = chunkData.length.toString(16);
    return `${chunkLengthHex};chunk-signature=${this.signature()}`;
  }

  stringToSign() {
    const hash = (string, encoding) =>
      crypto.createHash('sha256').update(string, 'utf8').digest(encoding);

    return this.chunkData === undefined
      ? super.stringToSign()
      : [
          'AWS4-HMAC-SHA256-PAYLOAD',
          this.getDateTime(),
          this.credentialString(),
          this.previousSignature,
          hash('', 'hex'),
          hash(this.chunkData, 'hex'),
        ].join('\n');
  }
};

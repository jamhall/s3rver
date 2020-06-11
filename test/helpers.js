'use strict';

const AWS = require('aws-sdk');
const fs = require('fs');
const { times } = require('lodash');
const os = require('os');
const path = require('path');
const pMap = require('p-map');

const S3rver = require('..');

const tmpDir = path.join(os.tmpdir(), 's3rver_test');

const instances = new Set();

exports.resetTmpDir = function resetTmpDir() {
  try {
    fs.rmdirSync(tmpDir, {recursive: true});
  } catch (err) {
    /* directory didn't exist */
  }
  fs.mkdirSync(tmpDir);
};

exports.generateTestObjects = function generateTestObjects(
  s3Client,
  bucket,
  amount,
) {
  const padding = amount.toString().length;
  const objects = times(amount, i => ({
    Bucket: bucket,
    Key: 'key' + i.toString().padStart(padding, '0'),
    Body: 'Hello!',
  }));

  return pMap(objects, object => s3Client.putObject(object).promise(), {
    concurrency: 100,
  });
};

exports.createServerAndClient = async function createServerAndClient(options) {
  const s3rver = new S3rver(options);
  const { port } = await s3rver.run();
  instances.add(s3rver);

  const s3Client = new AWS.S3({
    accessKeyId: 'S3RVER',
    secretAccessKey: 'S3RVER',
    endpoint: `http://localhost:${port}`,
    sslEnabled: false,
    s3ForcePathStyle: true,
    signatureVersion: 'v2',
  });

  return { s3rver, s3Client };
};

exports.instances = instances;

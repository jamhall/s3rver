'use strict';

const AWS = require('aws-sdk');
const { expect } = require('chai');
const { once } = require('events');
const express = require('express');
const FormData = require('form-data');
const fs = require('fs');
const crypto = require('crypto');
const request = require('request-promise-native').defaults({
  resolveWithFullResponse: true,
});

const { createServerAndClient, generateTestObjects } = require('./helpers');

const S3rver = require('../lib/s3rver');

describe('S3rver', () => {
  describe('#run', () => {
    it('supports running on port 0', async function () {
      const server = new S3rver({
        port: 0,
      });
      const { port } = await server.run();
      await server.close();
      expect(port).to.be.above(0);
    });

    it('creates preconfigured buckets on startup', async function () {
      const buckets = [{ name: 'bucket1' }, { name: 'bucket2' }];
      const server = new S3rver({
        configureBuckets: buckets,
      });
      const { port } = await server.run();
      const s3Client = new AWS.S3({
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
        endpoint: `http://localhost:${port}`,
        sslEnabled: false,
        s3ForcePathStyle: true,
      });
      try {
        const res = await s3Client.listBuckets().promise();
        expect(res.Buckets).to.have.lengthOf(2);
      } finally {
        await server.close();
      }
    });

    it('creates a preconfigured bucket with configs on startup', async function () {
      const bucket = {
        name: 'bucket1',
        configs: [
          fs.readFileSync('./example/cors.xml'),
          fs.readFileSync('./example/website.xml'),
        ],
      };
      const server = new S3rver({
        configureBuckets: [bucket],
      });
      const { port } = await server.run();
      const s3Client = new AWS.S3({
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
        endpoint: `http://localhost:${port}`,
        sslEnabled: false,
        s3ForcePathStyle: true,
      });
      try {
        await s3Client.getBucketCors({ Bucket: bucket.name }).promise();
        await s3Client.getBucketWebsite({ Bucket: bucket.name }).promise();
      } finally {
        await server.close();
      }
    });
  });

  describe('#close', () => {
    it('cleans up after close if the resetOnClose setting is true', async function () {
      const bucket = { name: 'foobars' };

      const server = new S3rver({
        resetOnClose: true,
        configureBuckets: [bucket],
      });
      const { port } = await server.run();
      const s3Client = new AWS.S3({
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
        endpoint: `http://localhost:${port}`,
        sslEnabled: false,
        s3ForcePathStyle: true,
      });
      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        await server.close();
      }
      await expect(server.store.listBuckets()).to.eventually.have.lengthOf(0);
    });

    it('does not clean up after close if the resetOnClose setting is false', async function () {
      const bucket = { name: 'foobars' };

      const server = new S3rver({
        resetOnClose: false,
        configureBuckets: [bucket],
      });
      const { port } = await server.run();
      const s3Client = new AWS.S3({
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
        endpoint: `http://localhost:${port}`,
        sslEnabled: false,
        s3ForcePathStyle: true,
      });
      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        await server.close();
      }
      await expect(server.store.listBuckets()).to.eventually.have.lengthOf(1);
    });

    it('does not clean up after close if the resetOnClose setting is not set', async function () {
      const bucket = { name: 'foobars' };

      const server = new S3rver({
        configureBuckets: [bucket],
      });
      const { port } = await server.run();
      const s3Client = new AWS.S3({
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
        endpoint: `http://localhost:${port}`,
        sslEnabled: false,
        s3ForcePathStyle: true,
      });
      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        await server.close();
      }
      await expect(server.store.listBuckets()).to.eventually.have.lengthOf(1);
    });
  });

  describe("event 'event'", () => {
    let s3rver;
    let s3Client;

    beforeEach(async () => {
      ({ s3rver, s3Client } = await createServerAndClient({
        configureBuckets: [{ name: 'bucket-a' }, { name: 'bucket-b' }],
      }));
    });

    it('triggers an event with a valid message structure', async function () {
      const eventPromise = once(s3rver, 'event');
      const body = 'Hello!';
      await s3Client
        .putObject({ Bucket: 'bucket-a', Key: 'testPutKey', Body: body })
        .promise();
      const [event] = await eventPromise;
      const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(event.Records[0].eventTime).to.match(iso8601);
      expect(new Date(event.Records[0].eventTime)).to.not.satisfy(isNaN);
    });

    it('triggers a Post event', async function () {
      const eventPromise = once(s3rver, 'event');
      const body = 'Hello!';

      const form = new FormData();
      form.append('key', 'testPostKey');
      form.append('file', body);
      await request.post('bucket-a', {
        baseUrl: s3Client.endpoint.href,
        body: form,
        headers: form.getHeaders(),
      });

      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectCreated:Post');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-a');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testPostKey',
        size: body.length,
        eTag: crypto.createHash('md5').update(body).digest('hex'),
      });
    });

    it('triggers a Put event', async function () {
      const eventPromise = once(s3rver, 'event');
      const body = 'Hello!';
      await s3Client
        .putObject({ Bucket: 'bucket-a', Key: 'testPutKey', Body: body })
        .promise();
      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectCreated:Put');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-a');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testPutKey',
        size: body.length,
        eTag: crypto.createHash('md5').update(body).digest('hex'),
      });
    });

    it('triggers a Copy event', async function () {
      const body = 'Hello!';
      await s3Client
        .putObject({ Bucket: 'bucket-a', Key: 'testPut', Body: body })
        .promise();
      const eventPromise = once(s3rver, 'event');
      await s3Client
        .copyObject({
          Bucket: 'bucket-b',
          Key: 'testCopy',
          CopySource: '/bucket-a/testPut',
        })
        .promise();
      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectCreated:Copy');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-b');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testCopy',
        size: body.length,
      });
    });

    it('triggers a Delete event', async function () {
      const body = 'Hello!';
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'testDelete',
          Body: body,
        })
        .promise();
      const eventPromise = once(s3rver, 'event');
      await s3Client
        .deleteObject({ Bucket: 'bucket-a', Key: 'testDelete' })
        .promise();
      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectRemoved:Delete');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-a');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testDelete',
      });
    });
  });

  it('can be mounted on a subpath in an Express app', async function () {
    const s3rver = new S3rver({
      configureBuckets: [{ name: 'bucket-a' }, { name: 'bucket-b' }],
    });
    await s3rver.configureBuckets();

    const app = express();
    app.use('/basepath', s3rver.getMiddleware());
    const httpServer = app.listen(0);
    await once(httpServer, 'listening');

    try {
      const { port } = httpServer.address();
      const s3Client = new AWS.S3({
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
        endpoint: `http://localhost:${port}/basepath`,
        sslEnabled: false,
        s3ForcePathStyle: true,
      });
      const res = await s3Client.listBuckets().promise();
      expect(res.Buckets).to.have.lengthOf(2);
      await s3Client
        .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
        .promise();
    } finally {
      httpServer.close();
      await once(httpServer, 'close');
    }
  });
});

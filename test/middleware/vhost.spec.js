'use strict';

const { expect } = require('chai');
const xmlParser = require('fast-xml-parser');
const { zip } = require('lodash');
const he = require('he');
const moment = require('moment');
const request = require('request-promise-native');

const { createServerAndClient } = require('../helpers');

describe('Virtual Host resolution', () => {
  let s3Client;
  const buckets = [{ name: 'bucket0' }, { name: 'bucket1' }];

  beforeEach(async function() {
    ({ s3Client } = await createServerAndClient({
      configureBuckets: buckets,
    }));
  });

  it('reaches the server with a bucket subdomain', async function() {
    const body = await request({
      url: s3Client.endpoint,
      headers: { host: 'bucket0.s3.amazonaws.com' },
    });
    expect(body).to.include(`<Name>bucket0</Name>`);
  });

  it('reaches the server with a bucket vhost', async function() {
    const body = await request({
      url: s3Client.endpoint,
      headers: { host: 'bucket0' },
    });
    expect(body).to.include(`<Name>bucket0</Name>`);
  });

  it('lists buckets at a custom service endpoint', async function() {
    const { s3Client } = await createServerAndClient({
      serviceEndpoint: 'example.com',
      configureBuckets: buckets,
    });
    const res = await request({
      url: s3Client.config.endpoint,
      headers: { host: 's3.example.com' },
    });
    const parsedBody = xmlParser.parse(res, {
      tagValueProcessor: a => he.decode(a),
    });
    expect(parsedBody).to.haveOwnProperty('ListAllMyBucketsResult');
    const parsedBuckets = parsedBody.ListAllMyBucketsResult.Buckets.Bucket;
    expect(parsedBuckets).to.be.instanceOf(Array);
    expect(parsedBuckets).to.have.lengthOf(buckets.length);
    for (const [bucket, config] of zip(parsedBuckets, buckets)) {
      expect(bucket.Name).to.equal(config.name);
      expect(moment(bucket.CreationDate).isValid()).to.be.true;
    }
  });

  it('lists objects in a bucket at a custom service endpoint', async function() {
    const { s3Client } = await createServerAndClient({
      serviceEndpoint: 'example.com',
      configureBuckets: buckets,
    });
    const res = await request({
      url: s3Client.config.endpoint,
      headers: { host: 'bucket0.s3.example.com' },
    });
    const parsedBody = xmlParser.parse(res, {
      tagValueProcessor: a => he.decode(a),
    });
    expect(parsedBody.ListBucketResult.Name).to.equal('bucket0');
  });
});

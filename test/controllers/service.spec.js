'use strict';

const { expect } = require('chai');
const { zip } = require('lodash');
const moment = require('moment');

const { createServerAndClient } = require('../helpers');

describe('Operations on the Service', () => {
  describe('GET Service', () => {
    const buckets = [
      { name: 'bucket1' },
      { name: 'bucket2' },
      { name: 'bucket3' },
      { name: 'bucket4' },
      { name: 'bucket5' },
      { name: 'bucket6' },
    ];

    it('returns a list of buckets', async function () {
      const { s3Client } = await createServerAndClient({
        configureBuckets: buckets,
      });
      const data = await s3Client.listBuckets().promise();
      expect(data.Buckets).to.have.lengthOf(6);
      for (const [bucket, config] of zip(data.Buckets, buckets)) {
        expect(bucket.Name).to.equal(config.name);
        expect(moment(bucket.CreationDate).isValid()).to.be.true;
      }
    });
  });
});

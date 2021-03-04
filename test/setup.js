/* eslint-env mocha */
'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const os = require('os');
const path = require('path');

const S3rver = require('..');

const { resetTmpDir, instances } = require('./helpers');

chai.use(chaiAsPromised);

// Change the default options to be more test-friendly
const tmpDir = path.join(os.tmpdir(), 's3rver_test');
S3rver.defaultOptions.port = 0;
S3rver.defaultOptions.silent = true;
S3rver.defaultOptions.directory = tmpDir;

beforeEach(resetTmpDir);

afterEach(async function () {
  await Promise.all(
    [...instances].map(async (instance) => {
      try {
        await instance.close();
      } catch (err) {
        console.warn(err);
      }
    }),
  );
  instances.clear();
});

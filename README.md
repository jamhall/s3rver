S3rver
==================

S3rver is a NodeJs port of the excellent [FakeS3](https://github.com/jubos/fake-s3) server.

S3rver is a lightweight server that responds to the same calls Amazon S3 responds to. It is extremely useful for testing of S3 in a sandbox environment without actually making calls to Amazon.

The goal of Fake S3 is to minimise runtime dependencies and be more of a development tool to test S3 calls in your code rather than a production server looking to duplicate S3 functionality.

> It is currently under active development.

Currently working

- [x] List buckets
- [x] Create bucket
- [x] Delete bucket
- [x] List objects for bucket (including prefix but not yet delimiter or max keys)
- [x] Store object for bucket (mutipart)
- [x] Delete object for bucket
- [x] Get object (including HEAD, If-Modified-Since, If-None-Match)
- [x] Get acls for an object (dummy data)

Not working

- [ ] Copy object
- [ ] Updated modified date when an object is updated


## Tests

> When running the tests with node v0.10.0 the following [error](https://github.com/mochajs/mocha/issues/777) is encountered. This is resolved by running the tests with v0.11.*. I recommend using [NVM](https://github.com/creationix/nvm) to manage your node versions.
  
To run the test suite, first install the dependancies, then run `npm test`:

```bash
$ npm install
$ npm test
```

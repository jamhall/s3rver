S3rver
==================

S3rver is a NodeJs port of the excellent [Fake S3](https://github.com/jubos/fake-s3) server.

S3rver is a lightweight server that responds to the **some** of the same calls [Amazon S3](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html) responds to. It is extremely useful for testing S3 in a sandbox environment without actually making calls to Amazon.

The goal of S3rver is to minimise runtime dependencies and be more of a development tool to test S3 calls in your code rather than a production server looking to duplicate S3 functionality.

> It is currently under active development.

### Currently working

- [x] List buckets
- [x] Create bucket
- [x] Delete bucket
- [x] List objects for bucket (including prefix but not yet delimiter or max keys)
- [x] Store object for bucket (mutipart)
- [x] Delete object for bucket
- [x] Get object (including HEAD, If-Modified-Since, If-None-Match)
- [x] Get acls for an object (dummy data)

### Working on

- [ ] Copy object
- [ ] Updated modified date when an object is updated
- [ ]  Implementing tests for listing objects by prefix


## Quick Start

Install s3rver:
  
```bash
npm install s3rver -g
```
You will now have a command on your path called *s3rver*

Executing this command for the various options:

```bash
s3rver --help
```
### Caveats

Currently multipart uploads is not supported. It's fairly complex and cumbersome to implement, however, if there is strong support from the community for it, then it will be implemented, or if you would like to implement it yourself, please go ahead and send a pull request : ) 

### Supported clients

Please see [Fake S3s wiki page](https://github.com/jubos/fake-s3/wiki/Supported-Clients) for a list of supported clients.

Please test, if you encounter any problems please do not hesitate to open an issue :)

## Tests

> When running the tests with node v0.10.0 the following [error](https://github.com/mochajs/mocha/issues/777) is encountered. This is resolved by running the tests with v0.11.*. I recommend using [NVM](https://github.com/creationix/nvm) to manage your node versions.
  
To run the test suite, first install the dependencies, then run `npm test`:

```bash
$ npm install
$ npm test
```

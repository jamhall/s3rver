S3rver
==================

[![NPM](https://nodei.co/npm/s3rver.png)](https://nodei.co/npm/s3rver/)

[![Build Status](https://api.travis-ci.org/jamhall/s3rver.png)](https://travis-ci.org/jamhall/s3rver)
[![Dependency Status](https://david-dm.org/jamhall/s3rver/status.svg)](https://david-dm.org/jamhall/s3rver)
[![Devdependency Status](https://david-dm.org/jamhall/s3rver/dev-status.svg)](https://david-dm.org/jamhall/s3rver?type=dev)
 
S3rver is a lightweight server that responds to **some** of the same calls [Amazon S3](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html) responds to. It is extremely useful for testing S3 in a sandbox environment without actually making calls to Amazon.

The goal of S3rver is to minimise runtime dependencies and be more of a development tool to test S3 calls in your code rather than a production server looking to duplicate S3 functionality.

## Supported methods

### Buckets

- Create bucket
- Delete bucket
- List buckets
- List content of buckets (prefix, delimiter, marker and max keys, common prefixes)

### Objects

- Put object (support for metadata, including ContentEncoding (gzipped files)
- Post object (multipart)
- Delete object(s)
- Get object (including using the HEAD method)
- Get dummy ACLs for an object
- Copy object (including updating of metadata)
- Listen to Put, Copy, Post and Delete events.

## Quick Start

Install s3rver:
  
```bash
$ npm install s3rver -g
```
You will now have a command on your path called *s3rver*

Executing this command for the various options:

```bash
$ s3rver --help
```

## Supported clients

Please see [Fake S3s wiki page](https://github.com/jubos/fake-s3/wiki/Supported-Clients) for a list of supported clients.
When listening on HTTPS with a self-signed certificate, the AWS SDK in a Node.js environment will need `httpOptions: { agent: new https.Agent({ rejectUnauthorized: false }) }` in order to allow interaction.

Please test, if you encounter any problems please do not hesitate to open an issue :)

## Static Website Hosting

If you specify an *indexDocument* then `GET` requests will serve the *indexDocument* if it is found, simulating the static website mode of AWS S3. An *errorDocument* can also be set, to serve a custom 404 page.

### Hostname Resolution

By default a bucket name needs to be given. So for a bucket called `mysite.local`, with an indexDocument of `index.html`. Visiting `http://localhost:4568/mysite.local/` in your browser will display the `index.html` file uploaded to the bucket.

However you can also setup a local hostname in your /etc/hosts file pointing at 127.0.0.1
```
localhost 127.0.0.1
mysite.local 127.0.0.1
```
Now you can access the served content at `http://mysite.local:4568/`

## Tests

The tests should be run by one of the active LTS versions. The CI Server runs the tests on the latest `6.x` and `8.x` releases.

To run the test suite, first install the dependencies, then run `npm test`:

```bash
$ npm install
$ npm test
```

## Programmatically running s3rver

You can also run s3rver programmatically. 

> This is particularly useful if you want to integrate s3rver into another projects tests that depends on access to an s3 environment

### new S3rver([options])

Creates a S3rver instance

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| port | `number` | `4578` | Port of the mock S3 server |
| hostname | `string` | `localhost` | Host/IP to bind to |
| key | `string` \| `Buffer` |  | Private key for running with TLS |
| cert | `string` \| `Buffer` |  | Certificate for running with TLS |
| silent | `boolean` | `false` | Suppress log messages | 
| directory | `string` |  | Data directory |
| cors | `string` \| `Buffer` | [S3 Sample policy](cors_sample_policy.xml) | Raw XML string or Buffer of CORS policy |
| indexDocument | `string` |  | Index document for static web hosting |
| errorDocument | `string` |  | Error document for static web hosting |
| removeBucketsOnClose | `boolean` | `false` | Remove all bucket data on server close |

### s3rver.run(callback)
Starts the server on the configured port and host

Example in mocha:

```javascript
const S3rver = require('s3rver');
let instance;

before(function (done) {
    instance = new S3rver({
        port: 4569,
        hostname: 'localhost',
        silent: false,
        directory: '/tmp/s3rver_test_directory'
    }).run((err, host, port) => {
        if(err) {
            return done(err);
        }
        done();
    });
});

after(function (done) {
    instance.close(done);
});
```

## Subscribing to S3 Event 

You can subscribe to Put, Copy,Post and Delete object events in the bucket, when you run s3rver programmatically.
Please have a look at [Aws page](http://docs.aws.amazon.com/AmazonS3/latest/dev/notification-content-structure.html) for details of event object. 
Apply filter function to subscribe to specific events.

```
const S3rver = require('s3rver');
const client = new S3rver({
        port: 4569,
        hostname: 'localhost',
        silent: false,
        directory: '/tmp/s3rver_test_directory'
    }).run(function (err, host, port) {
        if (err) {
            console.error(err)
        } else {
            console.log('now listening on host %s and port %d', host, port);
        }
    });

client.s3Event.subscribe(function (event) {
    console.log(event);
});

client.s3Event.filter(function (event) { return event.Records[0].eventName == 'ObjectCreated:Copy' }).subscribe(function (event) {
    console.log(event);
});
```


### s3rver.callback() ⇒ `function (req, res)`
*Also aliased as* **s3rver.getMiddleware()**

Creates and returns a callback that can be passed into `http.createServer()` or mounted in an Express app.

## Using [s3fs-fuse](https://github.com/s3fs-fuse/s3fs-fuse) with S3rver

You can connect to s3rver and mount a bucket to your local file system by using the following command:

```bash
$ s3fs bucket1 /tmp/3 -o url="http://localhost:4568" -o use_path_request_style -d -f -o f2 -o curldbg
```

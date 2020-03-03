# S3rver

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

You will now have a command on your path called _s3rver_

Executing this command for the various options:

```bash
$ s3rver --help
```

## Supported clients

Please see [Fake S3's wiki page](https://github.com/jubos/fake-s3/wiki/Supported-Clients) for a list of supported clients.
When listening on HTTPS with a self-signed certificate, the AWS SDK in a Node.js environment will need `httpOptions: { agent: new https.Agent({ rejectUnauthorized: false }) }` in order to allow interaction.

If your client only supports signed requests, specify the credentials

```javascript
{
  accessKeyId: "S3RVER",
  secretAccessKey: "S3RVER",
}
```

in your client's configuration.

You can customize the credentials by setting environment variables:

```
S3RVER_ACCESS_KEY_ID=S3RVER
S3RVER_SECRET_ACCESS_KEY=S3RVER
```

Please test, if you encounter any problems please do not hesitate to open an issue :)

## Static Website Hosting

If you specify a [website configuration file](https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUTwebsite.html#RESTBucketPUTwebsite-examples),
S3rver supports simulating S3's static website mode for incoming `GET` requests.

### Hostname Resolution

By default a bucket name needs to be given. So for a bucket called `mysite.local`, with an indexDocument of `index.html`. Visiting `http://localhost:4568/mysite.local/` in your browser will display the `index.html` file uploaded to the bucket.

However you can also setup a local hostname in your /etc/hosts file pointing at 127.0.0.1

```
localhost 127.0.0.1
mysite.local 127.0.0.1
```

Now you can access the served content at `http://mysite.local:4568/`

## Tests

The tests should be run by one of the active LTS versions. The CI Server runs the tests on the latest active releases.

To run the test suite, first install the dependencies, then run `npm test`:

```bash
$ npm install
$ npm test
```

## Programmatically running s3rver

You can also run s3rver programmatically.

> This is particularly useful if you want to integrate s3rver into another projects tests that depends on access to an s3 environment

## Class: `S3rver`

### new S3rver([options])

Creates a S3rver instance

<!-- prettier-ignore-start -->
| Option                         | Type                 | Default         | Description
| ------------------------------ | -------------------- | --------------- | -----------
| address                        | `string`             | `localhost`     | Host/IP to bind to
| port                           | `number`             | `4568`          | Port of the HTTP server
| key                            | `string` \| `Buffer` |                 | Private key for running with TLS
| cert                           | `string` \| `Buffer` |                 | Certificate for running with TLS
| silent                         | `boolean`            | `false`         | Suppress log messages
| serviceEndpoint                | `string`             | `amazonaws.com` | For self-hosted setups where S3rver should override the AWS S3 endpoint
| directory                      | `string`             |                 | Data directory
| resetOnClose                   | `boolean`            | `false`         | Remove all bucket data on server close
| allowMismatchedSignatures      | `boolean`            | `false`         | Prevent `SignatureDoesNotMatch` errors for all well-formed signatures
| configureBuckets\[].name       | `string`             |                 | The name of a prefabricated bucket to create when the server starts
| configureBuckets\[].configs\[] | `string` \| `Buffer` |                 | Raw XML string or Buffer of Bucket config
<!-- prettier-ignore-end -->

For your convenience, we've provided sample bucket configurations you can access using `require.resolve`:

```javascript
const corsConfig = require.resolve('s3rver/example/cors.xml');
const websiteConfig = require.resolve('s3rver/example/website.xml');

const s3rver = new S3rver({
  configureBuckets: [
    {
      name: 'test-bucket',
      configs: [fs.readFileSync(corsConfig), fs.readFileSync(websiteConfig)],
    },
  ],
});
```

Additional references for defining these configurations can be found here:

- CORS: https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUTcors.html
- Static website: https://docs.aws.amazon.com/AmazonS3/latest/API/RESTBucketPUTwebsite.html

### s3rver.run(callback)

### s3rver.close(callback)

Starts/stops the server on the configured port and host. Returns a Promise if no callback is specified.

Example in mocha:

```javascript
const S3rver = require('s3rver');
let instance;

before(function(done) {
  instance = new S3rver({
    port: 4569,
    hostname: 'localhost',
    silent: false,
    directory: '/tmp/s3rver_test_directory',
  }).run(done);
});

after(function(done) {
  instance.close(done);
});
```

### s3rver.callback() ⇒ `function (req, res)`

_Alias:_ **s3rver.getMiddleware()**

Creates and returns a callback that can be passed into `http.createServer()` or mounted in an Express app.

### s3rver.configureBuckets() => `Promise<void>`

Convenience method for configurating a set of buckets without going through S3's
API. Useful for quickly provisioning buckets before starting up the server.

### s3rver.reset() => `void`

Resets all bucket and configurations supported by the configured store.

## Subscribing to S3 Events

### Event: `'event'`

You can subscribe to notifications for PUT, POST, COPY and DELETE object events in the bucket when you run S3rver programmatically.
Please refer to [AWS's documentation](http://docs.aws.amazon.com/AmazonS3/latest/dev/notification-content-structure.html) for details of event object.

```javascript
const S3rver = require('s3rver');
const { fromEvent } = require('rxjs');
const { filter } = require('rxjs/operators');

const instance = new S3rver({
  port: 4568,
  hostname: 'localhost',
  silent: false,
  directory: '/tmp/s3rver_test_directory',
}).run((err, { address, port } = {}) => {
  if (err) {
    console.error(err);
  } else {
    console.log('now listening at address %s and port %d', address, port);
  }
});

const s3Events = fromEvent(instance, 'event');
s3Events.subscribe(event => console.log(event));
s3Events
  .pipe(filter(event => event.Records[0].eventName == 'ObjectCreated:Copy'))
  .subscribe(event => console.log(event));
```

## Using [s3fs-fuse](https://github.com/s3fs-fuse/s3fs-fuse) with S3rver

You can connect to s3rver and mount a bucket to your local file system by using the following command:

```bash
$ s3fs bucket1 /tmp/3 -o url="http://localhost:4568" -o use_path_request_style -d -f -o f2 -o curldbg
```

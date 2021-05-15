'use strict';

const { expect } = require('chai');
const express = require('express');
const fs = require('fs');
const request = require('request-promise-native').defaults({
  resolveWithFullResponse: true,
});
const { URL } = require('url');

const { toISO8601String } = require('../../lib/utils');

const { createServerAndClient } = require('../helpers');

describe('REST Authentication', () => {
  let s3rver;
  let s3Client;
  const buckets = [
    {
      name: 'bucket-a',
    },
  ];

  beforeEach(async function () {
    ({ s3rver, s3Client } = await createServerAndClient({
      configureBuckets: buckets,
    }));
  });

  it('can GET a signed URL with subdomain bucket', async function () {
    await s3Client
      .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
      .promise();
    const endpointHref = s3Client.endpoint.href;
    s3Client.setEndpoint(`https://s3.amazonaws.com`);
    Object.assign(s3Client.config, {
      s3ForcePathStyle: false,
    });
    const url = s3Client.getSignedUrl('getObject', {
      Bucket: 'bucket-a',
      Key: 'text',
    });
    const { host, pathname, searchParams } = new URL(url);
    const res = await request(new URL(pathname, endpointHref), {
      qs: searchParams,
      headers: { host },
    });
    expect(res.body).to.equal('Hello!');
  });

  it('can GET a signed URL with vhost bucket', async function () {
    await s3Client
      .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
      .promise();
    const endpointHref = s3Client.endpoint.href;
    s3Client.setEndpoint(
      `${s3Client.endpoint.protocol}//bucket-a:${s3Client.endpoint.port}${s3Client.endpoint.path}`,
    );
    Object.assign(s3Client.config, {
      s3ForcePathStyle: false,
      s3BucketEndpoint: true,
    });
    const url = s3Client.getSignedUrl('getObject', {
      Bucket: 'bucket-a',
      Key: 'text',
    });
    const { host, pathname, searchParams } = new URL(url);
    const res = await request(new URL(pathname, endpointHref), {
      qs: searchParams,
      headers: { host },
    });
    expect(res.body).to.equal('Hello!');
  });

  it('rejects a request specifying multiple auth mechanisms', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        qs: {
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          Signature: 'dummysig',
        },
        headers: {
          Authorization: 'AWS S3RVER:dummysig',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain('<Code>InvalidArgument</Code>');
  });

  it('rejects a request with an invalid authorization header [v2]', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        headers: {
          Authorization: 'AWS S3RVER dummysig',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain('<Code>InvalidArgument</Code>');
  });

  it('rejects a request with an invalid authorization header [v4]', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        headers: {
          // omitting Signature and SignedHeaders components
          Authorization:
            'AWS4-HMAC-SHA256 Credential=S3RVER/20060301/us-east-1/s3/aws4_request',
          'X-Amz-Content-SHA256': 'UNSIGNED-PAYLOAD',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain('<Code>AuthorizationHeaderMalformed</Code>');
  });

  it('rejects a request with invalid query params [v2]', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        qs: {
          AWSAccessKeyId: 'S3RVER',
          Signature: 'dummysig',
          // expiration is omitted
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>AccessDenied</Code>');
  });

  it('rejects a request with invalid query params [v4]', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        qs: {
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          'X-Amz-Signature': 'dummysig',
          // omitting most other parameters for sig v4
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain(
      '<Code>AuthorizationQueryParametersError</Code>',
    );
  });

  it('rejects a request with an incorrect signature in header [v2]', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        headers: {
          Authorization: 'AWS S3RVER:badsig',
          'X-Amz-Date': new Date().toUTCString(),
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>SignatureDoesNotMatch</Code>');
  });

  it('rejects a request with an incorrect signature in query params [v2]', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        qs: {
          AWSAccessKeyId: 'S3RVER',
          Signature: 'badsig',
          Expires: (Date.now() / 1000).toFixed() + 900,
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>SignatureDoesNotMatch</Code>');
  });

  it('rejects a request with a large time skew', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        headers: {
          Authorization: 'AWS S3RVER:dummysig',
          // 20 minutes in the future
          'X-Amz-Date': new Date(Date.now() + 20000 * 60).toUTCString(),
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>RequestTimeTooSkewed</Code>');
  });

  it('rejects an expired presigned request [v2]', async function () {
    s3Client.config.set('signatureVersion', 's3');
    const url = s3Client.getSignedUrl('getObject', {
      Bucket: 'bucket-a',
      Key: 'mykey',
      Expires: -10, // 10 seconds in the past
    });
    let res;
    try {
      res = await request(url);
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>AccessDenied</Code>');
  });

  it('rejects an expired presigned request [v4]', async function () {
    s3Client.config.set('signatureVersion', 'v4');
    const url = s3Client.getSignedUrl('getObject', {
      Bucket: 'bucket-a',
      Key: 'mykey',
      Expires: -10, // 10 seconds in the past
    });
    let res;
    try {
      res = await request(url);
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>AccessDenied</Code>');
  });

  it('rejects a presigned request with an invalid expiration [v4]', async function () {
    // aws-sdk unfortunately doesn't expose a way to set the timestamp of the request to presign
    // so we have to construct a mostly-valid request ourselves
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        qs: {
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          'X-Amz-Credential': 'S3RVER/20060301/us-east-1/s3/aws4_request',
          'X-Amz-SignedHeaders': 'host',
          'X-Amz-Signature': 'dummysig',
          // 10 minutes in the past
          'X-Amz-Date': toISO8601String(Date.now() - 20000 * 60),
          'X-Amz-Expires': 20,
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>AccessDenied</Code>');
  });

  it('overrides response headers in signed GET requests', async function () {
    await s3Client
      .putObject({
        Bucket: 'bucket-a',
        Key: 'image',
        Body: await fs.promises.readFile(
          require.resolve('../fixtures/image0.jpg'),
        ),
      })
      .promise();
    const url = s3Client.getSignedUrl('getObject', {
      Bucket: 'bucket-a',
      Key: 'image',
      ResponseContentType: 'image/jpeg',
      ResponseContentDisposition: 'attachment',
    });
    const res = await request(url);
    expect(res.headers['content-type']).to.equal('image/jpeg');
    expect(res.headers['content-disposition']).to.equal('attachment');
  });

  it('rejects anonymous requests with response header overrides in GET requests', async function () {
    await s3Client
      .putObject({
        Bucket: 'bucket-a',
        Key: 'image',
        Body: await fs.promises.readFile(
          require.resolve('../fixtures/image0.jpg'),
        ),
      })
      .promise();
    let res;
    try {
      res = await request('bucket-a/image', {
        baseUrl: s3Client.endpoint.href,
        qs: {
          'response-content-type': 'image/jpeg',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain('<Code>InvalidRequest</Code>');
  });

  it('adds x-amz-meta-* metadata specified via query parameters', async function () {
    const url = s3Client.getSignedUrl('putObject', {
      Bucket: 'bucket-a',
      Key: 'mykey',
      Metadata: {
        somekey: 'value',
      },
    });
    await request.put(url, { body: 'Hello!' });
    const object = await s3Client
      .headObject({
        Bucket: 'bucket-a',
        Key: 'mykey',
      })
      .promise();
    expect(object.Metadata).to.have.property('somekey', 'value');
  });

  it('can use signed URLs while mounted on a subpath', async function () {
    const app = express();
    app.use('/basepath', s3rver.getMiddleware());

    const { httpServer } = s3rver;
    httpServer.removeAllListeners('request');
    httpServer.on('request', app);
    s3Client.setEndpoint(
      `${s3Client.endpoint.protocol}//localhost:${s3Client.endpoint.port}/basepath`,
    );

    await s3Client
      .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
      .promise();
    const url = s3Client.getSignedUrl('getObject', {
      Bucket: 'bucket-a',
      Key: 'text',
    });
    const res = await request(url);
    expect(res.body).to.equal('Hello!');
  });

  it('can use signed vhost URLs while mounted on a subpath', async function () {
    await s3Client
      .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
      .promise();

    const app = express();
    app.use('/basepath', s3rver.getMiddleware());

    const { httpServer } = s3rver;
    httpServer.removeAllListeners('request');
    httpServer.on('request', app);

    const endpointHref = s3Client.endpoint.href;
    s3Client.setEndpoint(
      `${s3Client.endpoint.protocol}//bucket-a:${s3Client.endpoint.port}/basepath`,
    );
    Object.assign(s3Client.config, {
      s3ForcePathStyle: false,
      s3BucketEndpoint: true,
    });
    const url = s3Client.getSignedUrl('getObject', {
      Bucket: 'bucket-a',
      Key: 'text',
    });
    const { host, pathname, searchParams } = new URL(url);
    const res = await request(new URL(pathname, endpointHref), {
      qs: searchParams,
      headers: { host },
    });
    expect(res.body).to.equal('Hello!');
  });

  it('rejects a request with an incorrect signature in header [v4]', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        headers: {
          Authorization:
            'AWS4-HMAC-SHA256 Credential=S3RVER/20060301/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=badsig',
          'X-Amz-Content-SHA256': 'UNSIGNED-PAYLOAD',
          'X-Amz-Date': toISO8601String(Date.now()),
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>SignatureDoesNotMatch</Code>');
  });

  it('rejects a request with an incorrect signature in query params [v4]', async function () {
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: s3Client.endpoint.href,
        qs: {
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          'X-Amz-Credential': 'S3RVER/20200815/eu-west-2/s3/aws4_request',
          'X-Amz-Date': toISO8601String(Date.now()),
          'X-Amz-Expires': 30,
          'X-Amz-SignedHeaders': 'host',
          'X-Amz-Signature': 'badsig',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>SignatureDoesNotMatch</Code>');
  });
});

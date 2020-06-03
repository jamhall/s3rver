'use strict';

const { expect } = require('chai');
const fs = require('fs-extra');
const request = require('request-promise-native').defaults({
  resolveWithFullResponse: true,
});

const { createServerAndClient } = require('../helpers');

describe('Static Website Tests', function() {
  let s3Client;
  const buckets = [
    // a bucket with no additional config
    {
      name: 'bucket-a',
    },

    // A standard static hosting configuration with no custom error page
    {
      name: 'website0',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test0.xml')),
      ],
    },

    // A static website with a custom error page
    {
      name: 'website1',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test1.xml')),
      ],
    },

    // A static website with a single simple routing rule
    {
      name: 'website2',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test2.xml')),
      ],
    },

    // A static website with multiple routing rules
    {
      name: 'website3',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test3.xml')),
      ],
    },
  ];

  this.beforeEach(async () => {
    ({ s3Client } = await createServerAndClient({
      configureBuckets: buckets,
    }));
  });

  it('fails to read an object at the website endpoint from a bucket with no website configuration', async function() {
    await s3Client
      .putObject({
        Bucket: 'bucket-a',
        Key: 'page/index.html',
        Body: '<html><body>Hello</body></html>',
      })
      .promise();
    let res;
    try {
      res = await request('page/', {
        baseUrl: s3Client.config.endpoint,
        headers: { host: `bucket-a.s3-website-us-east-1.amazonaws.com` },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(404);
    expect(res.headers).to.have.property(
      'content-type',
      'text/html; charset=utf-8',
    );
    expect(res.body).to.contain('Code: NoSuchWebsiteConfiguration');
  });

  it('returns an index page at / path', async function() {
    const expectedBody = '<html><body>Hello</body></html>';
    await s3Client
      .putObject({
        Bucket: 'website0',
        Key: 'index.html',
        Body: expectedBody,
      })
      .promise();
    const res = await request('website0/', {
      baseUrl: s3Client.config.endpoint,
      headers: { accept: 'text/html' },
    });
    expect(res.body).to.equal(expectedBody);
  });

  it('allows redirects for image requests', async function() {
    let res;
    try {
      res = await request('website3/complex/image.png', {
        baseUrl: s3Client.config.endpoint,
        headers: { accept: 'image/png' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(307);
    expect(res.headers).to.have.property(
      'location',
      'https://custom/replacement',
    );
  });

  it('returns an index page at /page/ path', async function() {
    const expectedBody = '<html><body>Hello</body></html>';
    await s3Client
      .putObject({
        Bucket: 'website0',
        Key: 'page/index.html',
        Body: expectedBody,
      })
      .promise();
    const res = await request('website0/page/', {
      baseUrl: s3Client.config.endpoint,
      headers: { accept: 'text/html' },
    });
    expect(res.body).to.equal(expectedBody);
  });

  it('does not return an index page at /page/ path if an object is stored with a trailing /', async function() {
    const indexBody = '<html><body>Hello</body></html>';
    const expectedBody = '<html><body>Goodbye</body></html>';
    await s3Client
      .putObject({
        Bucket: 'website0',
        Key: 'page/index.html',
        Body: indexBody,
      })
      .promise();
    await s3Client
      .putObject({
        Bucket: 'website0',
        Key: 'page/',
        Body: expectedBody,
      })
      .promise();

    const res = await request('website0/page/', {
      baseUrl: s3Client.config.endpoint,
      headers: { accept: 'text/html' },
    });
    expect(res.body).to.equal(expectedBody);
  });

  it('redirects with a 302 status at /page path', async function() {
    const body = '<html><body>Hello</body></html>';
    await s3Client
      .putObject({
        Bucket: 'website0',
        Key: 'page/index.html',
        Body: body,
      })
      .promise();
    let res;
    try {
      res = await request('website0/page', {
        baseUrl: s3Client.config.endpoint,
        headers: { accept: 'text/html' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(302);
    expect(res.headers).to.have.property('location', '/website0/page/');
  });

  it('redirects with 302 status at /page path for subdomain-style bucket', async function() {
    const body = '<html><body>Hello</body></html>';
    await s3Client
      .putObject({
        Bucket: 'website0',
        Key: 'page/index.html',
        Body: body,
      })
      .promise();
    let res;
    try {
      res = await request('page', {
        baseUrl: s3Client.config.endpoint,
        headers: { host: 'website0.s3-website-us-east-1.amazonaws.com' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(302);
    expect(res.headers).to.have.property('location', '/page/');
  });

  it('returns a HTML 404 error page', async function() {
    let res;
    try {
      res = await request('website0/page/not-exists', {
        baseUrl: s3Client.config.endpoint,
        headers: { accept: 'text/html' },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(404);
    expect(res.headers).to.have.property(
      'content-type',
      'text/html; charset=utf-8',
    );
  });

  it('serves a custom error page if it exists', async function() {
    const body = '<html><body>Oops!</body></html>';
    await s3Client
      .putObject({
        Bucket: 'website1',
        Key: 'error.html',
        Body: body,
        ContentType: 'text/html',
      })
      .promise();
    let res;
    try {
      res = await request('website1/page/not-exists', {
        baseUrl: s3Client.config.endpoint,
        headers: { accept: 'text/html' },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.headers).to.have.property(
      'content-type',
      'text/html; charset=utf-8',
    );
    expect(res.body).to.equal(body);
  });

  it('returns a XML error document for SDK requests', async function() {
    let error;
    try {
      await s3Client
        .getObject({
          Bucket: 'website0',
          Key: 'page/not-exists',
        })
        .promise();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.statusCode).to.equal(404);
    expect(error.code).to.equal('NoSuchKey');
  });

  it('stores an object with website-redirect-location metadata', async function() {
    const redirectLocation = 'https://github.com/jamhall/s3rver';
    await s3Client
      .putObject({
        Bucket: 'website0',
        Key: 'index.html',
        Body: '<html><body>Hello</body></html>',
        WebsiteRedirectLocation: redirectLocation,
      })
      .promise();
    const res = await s3Client
      .getObject({
        Bucket: 'website0',
        Key: 'index.html',
      })
      .promise();
    expect(res).to.have.property('WebsiteRedirectLocation', redirectLocation);
  });

  it('redirects for an object stored with a website-redirect-location', async function() {
    const redirectLocation = 'https://github.com/jamhall/s3rver';
    await s3Client
      .putObject({
        Bucket: 'website0',
        Key: 'index.html',
        Body: '<html><body>Hello</body></html>',
        WebsiteRedirectLocation: redirectLocation,
      })
      .promise();
    let res;
    try {
      res = await request(`website0/`, {
        baseUrl: s3Client.config.endpoint,
        headers: { accept: 'text/html' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(301);
    expect(res.headers).to.have.property('location', redirectLocation);
  });

  it('redirects for a custom error page stored with a website-redirect-location', async function() {
    const redirectLocation = 'https://github.com/jamhall/s3rver';
    const body = '<html><body>Hello</body></html>';
    await s3Client
      .putObject({
        Bucket: 'website1',
        Key: 'error.html',
        Body: body,
        WebsiteRedirectLocation: redirectLocation,
      })
      .promise();
    let res;
    try {
      res = await request(`website1/page/`, {
        baseUrl: s3Client.config.endpoint,
        headers: { accept: 'text/html' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(301);
    expect(res.headers).to.have.property('location', redirectLocation);
  });

  describe('Routing rules', () => {
    it('evaluates a single simple routing rule', async function() {
      let res;
      try {
        res = await request(`website2/test/key`, {
          baseUrl: s3Client.config.endpoint,
          headers: { accept: 'text/html' },
          followRedirect: false,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(301);
      expect(res.headers).to.have.property(
        'location',
        s3Client.config.endpoint + '/website2/replacement/key',
      );
    });

    it('evaluates a multi-rule config', async function() {
      let res;
      try {
        res = await request(`website3/simple/key`, {
          baseUrl: s3Client.config.endpoint,
          headers: { accept: 'text/html' },
          followRedirect: false,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(301);
      expect(res.headers).to.have.property(
        'location',
        s3Client.config.endpoint + '/website3/replacement/key',
      );
    });

    it('evaluates a complex rule', async function() {
      let res;
      try {
        res = await request(`website3/complex/key`, {
          baseUrl: s3Client.config.endpoint,
          headers: { accept: 'text/html' },
          followRedirect: false,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(307);
      expect(res.headers).to.have.property(
        'location',
        'https://custom/replacement',
      );
    });
  });
});

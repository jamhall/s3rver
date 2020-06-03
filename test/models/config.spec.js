'use strict';

const { expect } = require('chai');

const { S3WebsiteConfiguration } = require('../../lib/models/config');

describe('S3WebsiteConfiguration', () => {
  const notWellFormedError =
    'The XML you provided was not well-formed or did not validate against our published schema';

  describe('RoutingRules', () => {
    it('rejects when multiple RoutingRules elements exist', () => {
      expect(() =>
        S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
    <RoutingRules>
        <RoutingRule>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
      ).to.throw(notWellFormedError);
    });

    it('rejects when no RoutingRules.RoutingRule elements exist', () => {
      expect(() =>
        S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <other />
    </RoutingRules>
</WebsiteConfiguration>`),
      ).to.throw(notWellFormedError);
    });

    it('accepts single RoutingRules.RoutingRule', () => {
      expect(
        S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
      ).to.exist;
    });

    it('accepts multiple RoutingRules.RoutingRule', () => {
      expect(
        S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
        <RoutingRule>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
      ).to.exist;
    });

    describe('Condition', () => {
      it('rejects when no KeyPrefixEquals or HttpErrorCodeReturnedEquals elements exist', () => {
        expect(() =>
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <other />
            </Condition>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.throw(notWellFormedError);
      });

      it('rejects when HttpErrorCodeReturnedEquals is not in range', () => {
        expect(() =>
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <HttpErrorCodeReturnedEquals>304</HttpErrorCodeReturnedEquals>
            </Condition>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.throw(
          'The provided HTTP error code (304) is not valid. Valid codes are 4XX or 5XX.',
        );

        expect(() =>
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <HttpErrorCodeReturnedEquals>600</HttpErrorCodeReturnedEquals>
            </Condition>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.throw(
          'The provided HTTP error code (600) is not valid. Valid codes are 4XX or 5XX.',
        );
      });

      it('accepts a Condition with a KeyPrefixEquals element', () => {
        expect(
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <KeyPrefixEquals>test</KeyPrefixEquals>
            </Condition>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.exist;
      });

      it('accepts a Condition with a HttpErrorCodeReturnedEquals element', () => {
        expect(
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <HttpErrorCodeReturnedEquals>404</HttpErrorCodeReturnedEquals>
            </Condition>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.exist;
      });

      it('accepts a config with no Condition', () => {
        expect(
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.exist;
      });
    });

    describe('Redirect', () => {
      it("rejects when Redirect doesn't exist", () => {
        expect(() =>
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <KeyPrefixEquals>test</KeyPrefixEquals>
            </Condition>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.throw(notWellFormedError);
      });

      it('rejects when no valid Redirect options exist', () => {
        expect(() =>
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <KeyPrefixEquals>test</KeyPrefixEquals>
            </Condition>
            <Redirect>
                <other />
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.throw(notWellFormedError);
      });

      it("rejects when Protocol isn't http or https", () => {
        expect(() =>
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <KeyPrefixEquals>test</KeyPrefixEquals>
            </Condition>
            <Redirect>
                <Protocol>ftp</Protocol>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.throw(
          'Invalid protocol, protocol can be http or https. If not defined the protocol will be selected automatically.',
        );
      });

      it('accepts a valid Redirect config', () => {
        expect(
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Redirect>
                <HostName>example.com</HostName>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.exist;
      });

      it('parses values with XML encoding', () => {
        const config = S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
  <IndexDocument>
      <Suffix>index.html</Suffix>
  </IndexDocument>
  <RoutingRules>
      <RoutingRule>
          <Redirect>
              <ReplaceKeyPrefixWith>url?test=1&amp;key=</ReplaceKeyPrefixWith>
          </Redirect>
      </RoutingRule>
  </RoutingRules>
</WebsiteConfiguration>
    `);

        expect(config.routingRules[0].redirect.ReplaceKeyPrefixWith).to.equal(
          'url?test=1&key=',
        );
      });

      it('rejects a Redirect config with both ReplaceKeyWith and ReplaceKeyPrefixWith elements', () => {
        expect(() =>
          S3WebsiteConfiguration.validate(`
<WebsiteConfiguration>
    <IndexDocument>
        <Suffix>index.html</Suffix>
    </IndexDocument>
    <RoutingRules>
        <RoutingRule>
            <Condition>
                <KeyPrefixEquals>test</KeyPrefixEquals>
            </Condition>
            <Redirect>
                <ReplaceKeyWith>foo</ReplaceKeyWith>
                <ReplaceKeyPrefixWith>bar</ReplaceKeyPrefixWith>
            </Redirect>
        </RoutingRule>
    </RoutingRules>
</WebsiteConfiguration>`),
        ).to.throw(
          'You can only define ReplaceKeyPrefix or ReplaceKey but not both.',
        );
      });
    });
  });
});

"use strict";

class RoutingRule {
  constructor(config) {
    this.condition = config.Condition;
    this.redirect = config.Redirect;
  }

  evaluate(key, statusCode) {
    if (!this.shouldRedirect(key, statusCode)) {
      return null;
    }

    return {
      statusCode: this.getStatusCode(),
      location: this.getRedirectDestination(key)
    };
  }

  getStatusCode() {
    return this.redirect.HttpRedirectCode
      ? this.redirect.HttpRedirectCode
      : 302;
  }

  getRedirectDestination(key) {
    const redirectKey = this.redirect.ReplaceKeyPrefixWith
      ? key.replace(
          this.condition.KeyPrefixEquals,
          this.redirect.ReplaceKeyPrefixWith
        )
      : key;
    const url = `${this.redirect.Protocol}://${this.redirect.HostName}/${redirectKey}`;
    return url;
  }

  shouldRedirect(key, statusCode) {
    if (
      this.condition.KeyPrefixEquals &&
      this.condition.HttpErrorCodeReturnedEquals
    ) {
      return (
        key.startsWith(this.condition.KeyPrefixEquals) &&
        this.condition.HttpErrorCodeReturnedEquals === statusCode
      );
    }

    if (this.condition.KeyPrefixEquals) {
      return key.startsWith(this.condition.KeyPrefixEquals);
    }

    if (this.condition.HttpErrorCodeReturnedEquals) {
      return this.condition.HttpErrorCodeReturnedEquals === statusCode;
    }

    return false;
  }
}

module.exports = RoutingRule;

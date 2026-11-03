'use strict';

var assert = require('node:assert');
var framework = require('..');
var types = require('../lib/types');

describe('app', function () {
  it('renders a view', function () {
    var app = framework();
    assert.equal(app.render('home'), '<home>');
  });

  it('handles a route', function () {
    var app = framework();
    assert.equal(app({ view: 'list' }), '<list>');
    assert.equal(app.render('list'), '<list>');
  });

  it('knows a route', function () {
    assert.ok(types.isRoute({ view: 'x' }));
  });
});

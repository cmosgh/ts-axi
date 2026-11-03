'use strict';

var framework = require('../lib/app');

var app = framework();
console.log(app.render('basic'));

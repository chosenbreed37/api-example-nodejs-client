/*
 * Copyright 2017 HM Revenue & Customs
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Support for https
const fs = require('fs');
const http = require('http');
const https = require('https');

// Load environment variables
require('dotenv').load();
const env = process.env;

// Start Client configuration
const clientId = env.CLIENT_ID;
const clientSecret = env.CLIENT_SECRET;
const serverToken = env.SERVER_TOKEN;

const apiBaseUrl = 'https://test-api.service.hmrc.gov.uk/';
const serviceName = 'hello'

const serviceVersion = '1.0'

const unRestrictedEndpoint = '/world';
const appRestrictedEndpoint = '/application';
const userRestrictedEndpoint = '/user';
const vrn = '666334575';
const retrieveVatObligationsEndpoint = 'organisations/vat/' + vrn + '/obligations';

const oauthScope = 'hello read:vat';
// End Client configuration

const simpleOauthModule = require('simple-oauth2');
const request = require('superagent');
const express = require('express');
const app = express();

// set the view engine to ejs
app.set('view engine', 'ejs');

const dateFormat = require('dateformat');
const winston = require('winston');

const log = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({
      timestamp: () => dateFormat(Date.now(), "isoDateTime"),
      formatter: (options) => `${options.timestamp()} ${options.level.toUpperCase()} ${options.message ? options.message : ''}
          ${options.meta && Object.keys(options.meta).length ? JSON.stringify(options.meta) : ''}`
    })
  ]
});

const redirectUri = env.REDIRECT_URI;

const cookieSession = require('cookie-session');

app.use(cookieSession({
  name: 'session',
  keys: ['oauth2Token', 'caller'],
  maxAge: 10 * 60 * 60 * 1000 // 10 hours
}));


// OAuth2 module
const oauth2 = simpleOauthModule.create({
  client: {
    id: clientId,
    secret: clientSecret,
  },
  auth: {
    tokenHost: apiBaseUrl,
    tokenPath: '/oauth/token',
    authorizePath: '/oauth/authorize',
  },
});  

// Authorization uri definition
const authorizationUri = oauth2.authorizationCode.authorizeURL({
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: oauthScope,
});

// Route definitions...

// home-page route
app.get('/', (req, res) => {
  res.render('index', {
    service: `${serviceName} (v${serviceVersion})`,
    unRestrictedEndpoint: unRestrictedEndpoint,
    appRestrictedEndpoint: appRestrictedEndpoint,
    userRestrictedEndpoint: userRestrictedEndpoint,
    retrieveVatObligationsEndpoint: retrieveVatObligationsEndpoint
  });
});

// Call an unrestricted endpoint
app.get("/unrestrictedCall",(req,res) => {
    callApi(unRestrictedEndpoint, res);
});

// Call an application-restricted endpoint
app.get("/applicationCall",(req,res) => {

  callApi(appRestrictedEndpoint, res, serverToken);
});

// Call a user-restricted endpoint
app.get("/userCall",(req,res) => {
  if(req.session.oauth2Token){
    var accessToken = oauth2.accessToken.create(req.session.oauth2Token);

    if(accessToken.expired()){
        log.info('Token expired: ', accessToken.token);
        accessToken.refresh()
          .then((result) => {
            log.info('Refreshed token: ', result.token);
            req.session.oauth2Token = result.token;
            callApi(userRestrictedEndpoint, res, result.token.access_token);
          })
          .catch((error) => {
            log.error('Error refreshing token: ', error);
            res.send(error);
           });
    } else {
      log.info('Using token from session: ', accessToken.token);
      callApi(userRestrictedEndpoint, res, accessToken.token.access_token);
    }
  } else {
    log.info('Need to request token')
    req.session.caller = '/userCall';
    res.redirect(authorizationUri);
  }
});

// Callback service parsing the authorization token and asking for the access token
app.get('/oauth20/callback', (req, res) => {
  const options = {
    redirect_uri: redirectUri,
    code: req.query.code
  };

  oauth2.authorizationCode.getToken(options, (error, result) => {
    if (error) {
      log.error('Access Token Error: ', error);
      return res.json('Authentication failed');
    }

    log.info('Got token: ', result);
    // save token on session and return to calling page
    req.session.oauth2Token = result;
    res.redirect(req.session.caller);
  });
});

// Retrieve vat obligations
app.get('/retrieveVatObligations', (req, res) => {

  if(req.session.oauth2Token){
    var accessToken = oauth2.accessToken.create(req.session.oauth2Token);

    if(accessToken.expired()){
        log.info('Token expired: ', accessToken.token);
        accessToken.refresh()
          .then((result) => {
            log.info('Refreshed token: ', result.token);
            req.session.oauth2Token = result.token;
            callApi(userRestrictedEndpoint, res, result.token.access_token);
          })
          .catch((error) => {
            log.error('Error refreshing token: ', error);
            res.send(error);
           });
    } else {
      log.info('Using token from session: ', accessToken.token);
      // callApi(userRestrictedEndpoint, res, accessToken.token.access_token);
    const bearerToken = accessToken.token.access_token; 
    const acceptHeader = `application/vnd.hmrc.${serviceVersion}+json`;
    const url = apiBaseUrl + retrieveVatObligationsEndpoint + '?from=2018-07-01&to=2018-09-30';
    log.info(`Calling ${url} with Accept: ${acceptHeader}`);
    const req = request
      .get(url)
      .accept(acceptHeader)
      .set('Content-Type', 'application/json');
  
    if(bearerToken) {
      log.info('Using bearer token:', bearerToken);
      req.set('Authorization', `Bearer ${bearerToken}`);
    }
  
    req.end((err, apiResponse) => handleResponse(res, err, apiResponse));
    }
  } else {
    log.info('Need to request token')
    req.session.caller = '/retrieveVatObligations';
    res.redirect(authorizationUri);
  }
});

// SSL
app.use('/.well-known', express.static('.well-known'));

// Helper functions

function callApi(resource, res, bearerToken) {
  const acceptHeader = `application/vnd.hmrc.${serviceVersion}+json`;
  const url = apiBaseUrl + serviceName + resource;
  log.info(`Calling ${url} with Accept: ${acceptHeader}`);
  const req = request
    .get(url)
    .accept(acceptHeader);
  
  if(bearerToken) {
    log.info('Using bearer token:', bearerToken);
    req.set('Authorization', `Bearer ${bearerToken}`);
  }
  
  req.end((err, apiResponse) => handleResponse(res, err, apiResponse));
}

function handleResponse(res, err, apiResponse){
  if (err || !apiResponse.ok) {
    log.error('Handling error response: ', err);
    res.send(err);
  } else {
    res.send(apiResponse.body);
  }
};

function str(token){
  return `[A:${token.access_token} R:${token.refresh_token} X:${token.expires_at}]`;
}

// const privateKey = fs.readFileSync('.ssl/private.key', 'utf8');
// const certificate = fs.readFileSync('.ssl/certificate.crt', 'utf8');
// const ca = fs.readFileSync('.ssl/ca_bundle.crt', 'utf8');

const credentials = {
	/*key: privateKey,
	cert: certificate,
	ca: caA*/ 
};

const httpServer = http.createServer(app);
const httpsServer = https.createServer(credentials, app);

httpServer.listen(env.PORT || 8080, () => {
	console.log('HTTPS Server running on port 8080');
});


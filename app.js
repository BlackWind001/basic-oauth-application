const http = require('http');
const fsPromises = require('fs/promises');
const path = require('path');

const hostname = '127.0.0.1';
const port = process.env.PORT || 3030;
const credFileName = 'cred.json';
const tokenFilename = 'tokens.json'
const credFilePath = path.join(__dirname, credFileName);
const tokenFilePath = path.join(__dirname, tokenFilename);

const HANDLED_ENDPOINTS = {
  AUTHORIZE_ME: 'authorize-me',
  ACCESS_TOKEN_REDIRECT: 'access-token-redirect',
  AUTH_CODE_REDIRECT: 'auth-code-redirect'  
};
const defaultAuthSearchParams = {
  redirect_uri: 'http://127.0.0.1:3030/auth-code-redirect',
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive',
  access_type: 'offline'
};

class LocalServer {
  constructor () {
    this.startServer();
  }

  createServiceAuthorizationURI () {
    const authURI = process.env.AUTH_URI;
    const client_id = process.env.CLIENT_ID;
    if (!authURI) {
      return;
    }

    const authURL = new URL(authURI);
    const authSearchParams = Object.assign({}, defaultAuthSearchParams);

    authSearchParams.client_id = client_id;

    Object.entries(authSearchParams).forEach(([key, value]) => {
      authURL.searchParams.append(key, value);
    });

    return authURL;
  }

  loadTokens ({ access_token, refresh_token }) {
    process.env.ACCESS_TOKEN = access_token;
    process.env.REFRESH_TOKEN = refresh_token;
  }

  async readAndLoadTokens () {
    const tokenFileHandle = await fsPromises.open(tokenFilePath, 'r');
    const tokenFileContents = await tokenFileHandle.readFile('utf-8');
    const { access_token, refresh_token } = JSON.parse(tokenFileContents);

    if(!access_token || !refresh_token) {
      throw new Error('Token file does not contain tokens');
    }

    this.loadTokens({ access_token, refresh_token });
    tokenFileHandle.close();
  }

  async storeTokens (tokensObj) {
    const tokenFileHandle = await fsPromises.open(tokenFilePath, 'w');

    tokenFileHandle.writeFile(JSON.stringify(tokensObj), { encoding: 'utf-8' });
    tokenFileHandle.close();
  }

  /**
   * 
   * @param {*} req 
   * @param {http.ServerResponse} res 
   */
  redirectToAuthorizeMe (req, res) {
    res.writeHead(301, {
      'Location': `/${HANDLED_ENDPOINTS.AUTHORIZE_ME}`
    });
    res.end();
  }

  /**
   * 
   * @param {http.IncomingMessage} req 
   * @param {http.ServerResponse} res 
   */
  handleAuthorizeMe (req, res) {
    res.writeHead(301, {
      'Location': this.createServiceAuthorizationURI()
    });
    res.end();
  }

  /**
   * 
   * @param {http.IncomingMessage} req 
   * @param {http.ServerResponse} res 
   * @param {URL} accessedURL 
   */
  async handleAuthCodeRedirect (req, res, accessedURL) {
    const searchParams = accessedURL.searchParams;
    const token_uri = process.env.TOKEN_URI;
    const client_id = process.env.CLIENT_ID;
    const client_secret = process.env.CLIENT_SECRET;
    const code = searchParams.get('code');

    if (!code || searchParams.has('error')) {
      throw new Error('Authentication code not found.');
    }
    if (token_uri === 'undefined' || !token_uri) {
      throw new Error('Valid token uri not found');
    }

    // call the token endpoint to get the access token
    const accTokenReqBody = (new URLSearchParams({
      client_id,
      client_secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: 'http://127.0.0.1:3030/auth-code-redirect'
    })).toString();
    let accTokenRes = await (await fetch(token_uri, {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: accTokenReqBody
    })).json();
    const { access_token, refresh_token } = accTokenRes;

    if (!(access_token && refresh_token )) {
      throw new Error('Could not get access token. Response received:', accTokenRes);
    }

    // Store the access_token and the refresh_token
    // and also load them in the current env for easier use
    await this.storeTokens({ access_token, refresh_token });
    this.loadTokens({ access_token, refresh_token });

    res.writeHead(301, { 'Location':`/anywhere` });
    res.end();
  }

  async handleUnhandledRoutes (req, res) {
    let access_token = process.env.ACCESS_TOKEN;
    let refresh_token = process.env.REFRESH_TOKEN;

    if (!access_token || !refresh_token || [access_token, refresh_token].includes('undefined')) {
      try {
        await this.readAndLoadTokens();
        access_token = process.env.ACCESS_TOKEN;
        refresh_token = process.env.REFRESH_TOKEN;
      }
      catch (e) {
        console.log('Error while reading and loading tokens', e);
        this.redirectToAuthorizeMe(req, res);
        return;
      }
    }

    const reqUri = 'https://www.googleapis.com/drive/v2/files';
    await fetch(reqUri, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${access_token}` }
    })
    .then((res) => {
      if (!res.ok) {
        throw new Error('Error in the response');
      }
      return res;
    })
    .then((res) => res.json())
    .then(console.log)
    .then(() => {
      res.statusCode = 200;
      res.end();
    })
    .catch((e) => {
      console.log(e);
      this.redirectToAuthorizeMe(req, res);
    });
  }

  /**
   * 
   * @param {http.IncomingMessage} req 
   * @param {http.ServerResponse} res 
   */
  async serverCallback (req, res) {
    try {
      const reqPath = req.url;
      const reqHost = req.headers.host;

      // TO-DO: This statement assumes that the current protocol is
      // http. Need a way to infer this information from a non
      // deprecated source.
      const accessedURL = new URL(reqPath,`http://${reqHost}`);
      const accessedPathname = accessedURL.pathname.slice(1);

      console.log(`Endpoint hit: `, accessedPathname);

      switch (accessedPathname) {
        case '': {
          this.handleUnhandledRoutes(req, res);
          return;
        }
        case HANDLED_ENDPOINTS.AUTHORIZE_ME: {
          this.handleAuthorizeMe(req, res);
          return;
        }
        case HANDLED_ENDPOINTS.AUTH_CODE_REDIRECT: {
          await this.handleAuthCodeRedirect(req, res, accessedURL);
          return;
        }
        default: {
          this.handleUnhandledRoutes(req, res);
        };
      }
    }
    catch (e) {
      console.error(e);
    }
  }

  startServer () {
    this.server = http.createServer(this.serverCallback.bind(this));

    this.server.listen(port, hostname, () => {
      console.log('Starting server on port', port);
    });
  }

}

async function readCredFile () {
  const fileHandle = await fsPromises.open(credFilePath);
  const fileContents = await fileHandle.readFile('utf-8');
  const credObj = JSON.parse(fileContents);

  process.env.CLIENT_ID = credObj.web.client_id;
  process.env.CLIENT_SECRET = credObj.web.client_secret;
  process.env.AUTH_URI = credObj.web.auth_uri;
  process.env.TOKEN_URI = credObj.web.token_uri;

  

  fileHandle.close();
}

async function main () {
  try {
    await readCredFile();
    new LocalServer();
  }
  catch (e) {
    console.error('Error', e);
    throw new Error(e);
  }
}

main();
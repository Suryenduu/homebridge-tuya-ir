import CryptoJS from 'crypto-js';
import { Logger } from 'homebridge';
import https from 'https';
import { URL } from 'url';
import { TuyaIRConfiguration } from '../model/TuyaIRConfiguration';
import { LoginHelper } from './LoginHelper';
import { cachedLookup, flushDnsCache } from './tuyaDnsCache';

const tuyaAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 30_000,
});

type RequestOptionsWithLookup = https.RequestOptions & {
  lookup?: (hostname: string, options: any, cb: any) => void;
};

export class APIInvocationHelper {
  public static getSignedValuesForGetWithAccessToken(
    url: URL,
    config: TuyaIRConfiguration,
    timestamp: number,
    accessToken: string,
  ) {
    return this.calculateSign(url, config, 'GET', timestamp, true, accessToken);
  }

  public static getSignedValuesForGetWithoutAccessToken(
    url: URL,
    config: TuyaIRConfiguration,
    timestamp: number,
  ) {
    return this.calculateSign(url, config, 'GET', timestamp, false);
  }

  public static invokeTuyaIrApi(
    log: Logger,
    config: TuyaIRConfiguration,
    endpoint: string,
    method: string,
    body: object,
    callback,
  ) {
    this.invokeWithCurrentProject(
      log,
      config,
      endpoint,
      method,
      body,
      callback,
      false,
    );
  }

  private static invokeWithCurrentProject(
    log: Logger,
    config: TuyaIRConfiguration,
    endpoint: string,
    method: string,
    body: object,
    callback,
    hasSwitched: boolean,
  ) {
    log.debug(
      `Calling endpoint ${endpoint} with project ${config.tuyaAPIClientId}`,
    );

    const loginHelper = LoginHelper.Instance(config, log);
    const accessToken = loginHelper.getAccessToken();

    // If this project has no token yet, log in before making the request.
    if (!accessToken) {
      loginHelper.login()
        .then(() => {
          this.invokeWithCurrentProject(
            log,
            config,
            endpoint,
            method,
            body,
            callback,
            hasSwitched,
          );
        })
        .catch((err) => {
          callback({
            success: false,
            msg: `Login failed: ${err?.message || err}`,
          });
        });

      return;
    }

    const timestamp = new Date().getTime();
    const bodyForSigning = method === 'GET' ? '' : JSON.stringify(body);

    const signedParameters = this.calculateSign(
      new URL(endpoint),
      config,
      method,
      timestamp,
      true,
      accessToken,
      bodyForSigning,
    );

    const options: RequestOptionsWithLookup = {
      method,
      headers: {
        client_id: config.tuyaAPIClientId,
        sign: signedParameters.signKey,
        t: timestamp,
        access_token: accessToken,
        sign_method: 'HMAC-SHA256',
        'Content-Type': 'application/json',
      },
      agent: tuyaAgent,
      lookup: cachedLookup,
    };

    const req = https.request(endpoint, options, (incomingMsg) => {
      let responseBody = '';

      incomingMsg.on('data', (chunk) => {
        responseBody += chunk;
      });

      incomingMsg.on('end', () => {
        let jsonBody: any;

        try {
          jsonBody = responseBody ? JSON.parse(responseBody) : {};
        } catch (error) {
          jsonBody = {
            success: false,
            msg: `Unable to parse body because '${error}'`,
          };
        }

        log.debug(`TUYA RESPONSE: ${responseBody}`);

        /*
         * If Tuya says this project has hit a quota/rate limit,
         * switch to the next project and retry the same request once.
         */
        if (
          this.isQuotaError(jsonBody, incomingMsg.statusCode) &&
          !hasSwitched &&
          config.switchToNextProject()
        ) {
          log.warn(
            `Tuya project ${config.tuyaAPIClientId} hit its API limit. ` +
            `Switching to the next Tuya project...`,
          );

          const newLoginHelper = LoginHelper.Instance(config, log);

          newLoginHelper.login()
            .then(() => {
              this.invokeWithCurrentProject(
                log,
                config,
                endpoint,
                method,
                body,
                callback,
                true,
              );
            })
            .catch((err) => {
              callback({
                success: false,
                msg: `Login to backup Tuya project failed: ${err?.message || err}`,
              });
            });

          return;
        }

        if (incomingMsg.statusCode != 200) {
          log.error(
            `Api call failed with response code ${incomingMsg.statusCode} ` +
            `for endpoint ${endpoint}`,
          );

          const msg =
            jsonBody?.msg || `HTTP ${incomingMsg.statusCode}`;

          callback({ success: false, msg });
          return;
        }

        if (!jsonBody.success && this.isTokenError(jsonBody)) {
          log.warn(
            `Token invalid (code ${jsonBody.code}), triggering refresh...`,
          );

          LoginHelper.Instance(config, log)
            .refreshAccessToken()
            .catch((err) => {
              log.error(
                `Reactive token refresh failed: ${err?.message || err}`,
              );
            });
        }

        log.debug('API call successful.', responseBody);
        callback(jsonBody);
      });
    });

    req.on('error', (err: any) => {
      try {
        const host = new URL(endpoint).hostname;
        const code = err?.code;

        if (
          code === 'ETIMEDOUT' ||
          code === 'ECONNRESET' ||
          code === 'EPIPE' ||
          code === 'EHOSTUNREACH' ||
          code === 'ENETUNREACH' ||
          code === 'ECONNREFUSED'
        ) {
          flushDnsCache(host);
        }
      } catch {
        // ignore
      }

      const message =
        err?.message || err?.code || String(err) || 'Unknown error';

      log.error(message, err?.stack);
      callback({
        success: false,
        msg: `Failed to invoke API '${message}'`,
      });
    });

    if (method !== 'GET') {
      req.write(JSON.stringify(body));
    }

    req.end();
  }

  private static calculateSign(
    url: URL,
    config: TuyaIRConfiguration,
    httpMethod: string,
    timestamp: number,
    withAccessToken: boolean,
    accessToken = '',
    body = '',
  ) {
    const returnObject = {
      timestamp: timestamp,
      signKey: '',
    };

    const signedParameters = this.stringToSign(
      url.search,
      url.pathname,
      httpMethod,
      body,
    );

    const signStr = signedParameters.signedUrl;

    const str = withAccessToken
      ? config.tuyaAPIClientId +
        accessToken +
        timestamp +
        signStr
      : config.tuyaAPIClientId +
        timestamp +
        signStr;

    returnObject.signKey = CryptoJS.HmacSHA256(
      str,
      config.tuyaAPISecret,
    ).toString().toUpperCase();

    return returnObject;
  }

  private static stringToSign(
    query,
    url,
    method,
    body = '',
  ) {
    const sha256 = CryptoJS.SHA256(body);

    return {
      signedUrl:
        method +
        '\n' +
        sha256 +
        '\n\n' +
        url +
        query,
      url: url + query,
    };
  }

  private static readonly TOKEN_ERROR_CODES = new Set([
    1010,
    1011,
    1012,
  ]);

  private static isTokenError(body: any): boolean {
    return this.TOKEN_ERROR_CODES.has(body?.code);
  }

  private static isQuotaError(
    body: any,
    statusCode?: number,
  ): boolean {
    if (statusCode === 429) {
      return true;
    }

    const message = String(
      body?.msg ||
      body?.message ||
      body?.error ||
      '',
    ).toLowerCase();

    const quotaWords = [
      'quota',
      'rate limit',
      'rate-limit',
      'frequency limit',
      'traffic limit',
      'request limit',
      'api limit',
      'too many requests',
    ];

    return quotaWords.some((word) => message.includes(word));
  }
}

import { Logger } from "homebridge";
import request from "https";
import { URL } from "url";
import { TuyaIRConfiguration } from "../model/TuyaIRConfiguration";
import { APIInvocationHelper } from "./APIInvocationHelper";
import { BaseHelper } from "./BaseHelper";

export class LoginHelper extends BaseHelper {
    private static instances: Map<string, LoginHelper> = new Map();

    private accessToken = "";
    private refreshToken = "";

    private retryCount = 0;
    private refreshInProgress: Promise<void> | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor(config: TuyaIRConfiguration, log: Logger) {
        super(config, log);
    }

    public static Instance(config: TuyaIRConfiguration, log: Logger) {
        const projectId = config.tuyaAPIClientId;

        let instance = this.instances.get(projectId);

        if (!instance) {
            instance = new this(config, log);
            this.instances.set(projectId, instance);
        } else {
            instance.config = config;
            instance.log = log;
            instance.apiHost = `https://openapi.tuya${config.deviceRegion}.com`;
        }

        return instance;
    }

    getAccessToken() {
        return this.accessToken;
    }

    login(): Promise<void> {
        return new Promise((resolve, reject) => {
            const LOGIN_URI = "/v1.0/token?grant_type=1";
            this.log.debug(`Logging in to the server ${this.apiHost}...`);

            this.invokeTuyaLoginAPI(this.apiHost + LOGIN_URI, (body) => {
                if (body.success) {
                    this.extractAccessTokenFromAPIResponse(body);
                    this.scheduleProactiveRefresh(body.result.expire_time);
                    this.retryCount = 0;
                    this.log.info(`Login successful.`);
                    resolve();
                } else {
                    this.handleLoginError(body.msg);
                    reject(new Error(body.msg));
                }
            });
        });
    }

    private invokeTuyaLoginAPI(endpoint: string, callback: (body: any) => void) {
        const timestamp = new Date().getTime();

        const signedParameters =
            APIInvocationHelper.getSignedValuesForGetWithoutAccessToken(
                new URL(endpoint),
                this.config,
                timestamp,
            );

        const options = {
            url: endpoint,
            headers: {
                'client_id': this.config.tuyaAPIClientId,
                'sign': signedParameters.signKey,
                't': timestamp,
                'sign_method': 'HMAC-SHA256',
                'nonce': ''
            }
        };

        this.log.debug(JSON.stringify(options));

        request.get(endpoint, options, (incomingMsg) => {
            let body = '';

            incomingMsg.on('data', (chunk) => {
                body += chunk;
            });

            incomingMsg.on('end', () => {
                this.log.debug(body);

                if (incomingMsg.statusCode != 200) {
                    this.log.error(
                        "Api call failed with response code " +
                        incomingMsg.statusCode
                    );

                    callback({
                        success: false,
                        msg: `HTTP ${incomingMsg.statusCode}`
                    });
                } else {
                    let jsonBody;

                    try {
                        jsonBody = JSON.parse(body);
                    } catch (error) {
                        jsonBody = {
                            success: false,
                            msg: `Unable to parse body because '${error}'`
                        };
                    }

                    this.log.debug("API call successful.");
                    callback(jsonBody);
                }
            });
        }).on('error', (err) => {
            this.log.error(
                "Login/refresh API call failed due to network error."
            );
            this.log.error(err.message, err.stack);

            callback({
                success: false,
                msg: `Network error: ${err.message}`
            });
        });
    }

    refreshAccessToken(): Promise<void> {
        if (this.refreshInProgress) {
            this.log.debug(
                "Token refresh already in progress, awaiting existing request..."
            );
            return this.refreshInProgress;
        }

        this.refreshInProgress = this.doRefresh().finally(() => {
            this.refreshInProgress = null;
        });

        return this.refreshInProgress;
    }

    private doRefresh(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.log.info("Need to refresh token now...");

            this.invokeTuyaLoginAPI(
                this.apiHost + "/v1.0/token/" + this.refreshToken,
                (body) => {
                    if (body.success) {
                        this.extractAccessTokenFromAPIResponse(body);
                        this.scheduleProactiveRefresh(body.result.expire_time);
                        this.retryCount = 0;

                        this.log.info(
                            `Token refreshed successfully. Next refresh after ${body.result.expire_time} seconds`
                        );

                        resolve();
                    } else {
                        this.log.error(
                            `Unable to refresh token: ${body.msg}. Trying fresh login...`
                        );

                        this.login().then(resolve, reject);
                    }
                }
            );
        });
    }

    private scheduleProactiveRefresh(refreshInterval: number) {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }

        this.refreshTimer = setTimeout(() => {
            this.refreshAccessToken().catch((error) => {
                this.log.error(
                    `Proactive token refresh failed: ${error}`
                );
            });
        }, Math.max(1, refreshInterval - 5) * 1000);
    }

    private extractAccessTokenFromAPIResponse(responseBody) {
        this.accessToken = responseBody.result.access_token;
        this.refreshToken = responseBody.result.refresh_token;
    }

    private handleLoginError(errorMessage: string) {
        this.retryCount++;

        this.log.error(
            `Failed to login due to error '${errorMessage}'. ` +
            `(attempt ${this.retryCount})`
        );
    }
}

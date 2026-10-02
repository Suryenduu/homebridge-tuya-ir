import { PlatformConfig } from "homebridge";
import { Device } from "./Device";

export interface TuyaProject {
    clientId: string;
    secret: string;
    region?: string;
}

export class TuyaIRConfiguration {
    public tuyaAPIClientId = "";
    public tuyaAPISecret = "";
    public deviceRegion = "";
    public irDeviceId = "";
    public autoFetchRemotesFromServer = true;
    public configuredRemotes: Device[] = [];
    public apiHost = "";

    public tuyaProjects: TuyaProject[] = [];
    public activeProjectIndex = 0;

    constructor(config: PlatformConfig, index: number) {
        this.deviceRegion = config.deviceRegion;
        this.irDeviceId = config.smartIR[index].deviceId;
        this.autoFetchRemotesFromServer = config.smartIR[index].autoFetchRemotesFromServer;
        this.configuredRemotes =
            config.smartIR[index].configuredRemotes?.map(v => new Device(v)) ?? [];

        if (Array.isArray(config.tuyaProjects) && config.tuyaProjects.length > 0) {
            this.tuyaProjects = config.tuyaProjects.map((project: any) => ({
                clientId: project.clientId,
                secret: project.secret,
                region: project.region || this.deviceRegion,
            }));
        }

        if (this.tuyaProjects.length === 0) {
            this.tuyaProjects = [{
                clientId: config.tuyaAPIClientId,
                secret: config.tuyaAPISecret,
                region: this.deviceRegion,
            }];
        }

        this.tuyaAPIClientId = this.tuyaProjects[0].clientId;
        this.tuyaAPISecret = this.tuyaProjects[0].secret;
        this.deviceRegion = this.tuyaProjects[0].region || this.deviceRegion;
        this.apiHost = `https://openapi.tuya${this.deviceRegion}.com`;
    }
public switchToNextProject(): boolean {
    if (this.tuyaProjects.length <= 1) {
        return false;
    }

    const nextIndex =
        (this.activeProjectIndex + 1) % this.tuyaProjects.length;

    this.activeProjectIndex = nextIndex;

    const project = this.tuyaProjects[nextIndex];

    this.tuyaAPIClientId = project.clientId;
    this.tuyaAPISecret = project.secret;
    this.deviceRegion = project.region || this.deviceRegion;
    this.apiHost = `https://openapi.tuya${this.deviceRegion}.com`;

    return true;
}
}

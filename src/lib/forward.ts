import { AudioCodec, Camera, CommandResult, CommandType, Device, DoorbellCamera, EntrySensor, ErrorCode, IndoorCamera, MotionSensor, ParamType, PropertyValue, Station, StreamMetadata, VideoCodec, AlarmEvent } from "eufy-security-client";
import { Readable } from "stream";

import { JSONValue, OutgoingEvent } from "./outgoing_message";
import { dumpStation } from "./station/state";
import { StationEvent } from "./station/event";
import { dumpDevice } from "./device/state";
import { DeviceEvent } from "./device/event";
import { DriverEvent } from "./driver/event";
import { Client, ClientsController } from "./server";
import { StationCommand } from "./station/command";
import { DeviceCommand } from "./device/command";
import { maxSchemaVersion as internalSchemaVersion } from "./const";
import { DeviceMessageHandler } from "./device/message_handler";
import { DriverMessageHandler } from "./driver/message_handler";

export class EventForwarder {

    constructor(private clients: ClientsController) {}

    public start(): void {

        this.clients.driver.on("tfa request", () => {
            this.forwardEvent({
                source: "driver",
                event: DriverEvent.verifyCode,
            }, 0);
        });

        this.clients.driver.on("captcha request", (id: string, captcha: string) => {
            DriverMessageHandler.captchaId = id;
            this.forwardEvent({
                source: "driver",
                event: DriverEvent.captchaRequest,
                captchaId: id,
                captcha: captcha,
            }, 7);
        });

        this.clients.driver.on("connect", () => {
            this.clients.clients.forEach((client) =>
                this.sendEvent(client, {
                    source: "driver",
                    event: DriverEvent.connected,
                })
            );
        });

        this.clients.driver.on("close", () => {
            this.clients.clients.forEach((client) =>
                this.sendEvent(client, {
                    source: "driver",
                    event: DriverEvent.disconnected,
                })
            );
        });

        this.clients.driver.on("push connect", () => {
            this.clients.clients.forEach((client) =>
                this.sendEvent(client, {
                    source: "driver",
                    event: DriverEvent.pushConnected,
                })
            );
        });

        this.clients.driver.on("push close", () => {
            this.clients.clients.forEach((client) =>
                this.sendEvent(client, {
                    source: "driver",
                    event: DriverEvent.pushDisconnected,
                })
            );
        });

        this.clients.driver.on("station added", (station: Station) => {
            this.clients.clients.forEach((client) =>
                this.sendEvent(client, {
                    source: "station",
                    event: StationEvent.stationAdded,
                    station: dumpStation(station, client.schemaVersion) as JSONValue,
                })
            );
            this.setupStation(station);
        });

        this.clients.driver.on("station removed", (station: Station) => {
            this.clients.clients.forEach((client) =>
                this.sendEvent(client, {
                    source: "station",
                    event: StationEvent.stationRemoved,
                    station: dumpStation(station, client.schemaVersion) as JSONValue,
                })
            );
        });

        this.clients.driver.on("device added", (device: Device) => {
            this.clients.clients.forEach((client) =>
                this.sendEvent(client, {
                    source: "device",
                    event: DeviceEvent.deviceAdded,
                    device: dumpDevice(device, client.schemaVersion) as JSONValue,
                })
            );
            this.setupDevice(device);
        });

        this.clients.driver.on("device removed", (device: Device) => {
            this.clients.clients.forEach((client) =>
                this.sendEvent(client, {
                    source: "device",
                    event: DeviceEvent.deviceRemoved,
                    device: dumpDevice(device, client.schemaVersion) as JSONValue,
                })
            );
        });

        this.clients.driver.getStations().forEach(station => {
            this.setupStation(station);
        });

        this.clients.driver.getDevices().forEach(device => {
            this.setupDevice(device);
        });

        this.clients.driver.on("station livestream start", (station: Station, device: Device, metadata: StreamMetadata, videostream: Readable, audiostream: Readable) => {
            const serialNumber = device.getSerial();
            this.clients.clients.filter((cl) => cl.receiveLivestream[serialNumber] === true && cl.isConnected)
                .forEach((client) => {
                    if (client.schemaVersion >= 2) {
                        client.sendEvent({
                            source: "device",
                            event: DeviceEvent.livestreamStarted,
                            serialNumber: serialNumber
                        });
                    }
                });
            videostream.on("data", (chunk: Buffer) => {
                this.clients.clients.filter((cl) => cl.receiveLivestream[serialNumber] === true && cl.isConnected)
                    .forEach((client) => {
                        if (client.schemaVersion >= 2) {
                            client.sendEvent({
                                source: "device",
                                event: DeviceEvent.livestreamVideoData,
                                serialNumber: serialNumber,
                                buffer: chunk as unknown as JSONValue,
                                metadata: { 
                                    videoCodec: VideoCodec[metadata.videoCodec],
                                    videoFPS: metadata.videoFPS,
                                    videoHeight: metadata.videoHeight,
                                    videoWidth: metadata.videoWidth,
                                }
                            });
                        }
                    });
            });
            audiostream.on("data", (chunk: Buffer) => {
                this.clients.clients.filter((cl) => cl.receiveLivestream[serialNumber] === true && cl.isConnected)
                    .forEach((client) => {
                        if (client.schemaVersion >= 2) {
                            client.sendEvent({
                                source: "device",
                                event: DeviceEvent.livestreamAudioData,
                                serialNumber: serialNumber,
                                buffer: chunk as unknown as JSONValue,
                                metadata: { 
                                    audioCodec: AudioCodec[metadata.audioCodec],
                                }
                            });
                        }
                    });
            });
        });

        this.clients.driver.on("station livestream stop", (station: Station, device: Device) => {
            const serialNumber = device.getSerial();
            this.clients.clients.filter((cl) => cl.receiveLivestream[serialNumber] === true && cl.isConnected)
                .forEach((client) => {
                    if (client.schemaVersion >= 2) {
                        client.sendEvent({
                            source: "device",
                            event: DeviceEvent.livestreamStopped,
                            serialNumber: serialNumber,
                        });
                    }
                    client.receiveLivestream[serialNumber] = false;
                    DeviceMessageHandler.removeStreamingDevice(station.getSerial(), client);
                });
        });

        this.clients.driver.on("station download start", (station: Station, device: Device, metadata: StreamMetadata, videostream: Readable, audiostream: Readable) => {
            const serialNumber = device.getSerial();
            this.clients.clients.filter((cl) => cl.receiveLivestream[serialNumber] === true && cl.isConnected)
                .forEach((client) => {
                    if (client.schemaVersion >= 3) {
                        client.sendEvent({
                            source: "device",
                            event: DeviceEvent.downloadStarted,
                            serialNumber: serialNumber
                        });
                    }
                });
            videostream.on("data", (chunk: Buffer) => {
                this.clients.clients.filter((cl) => cl.isConnected)
                    .forEach((client) => {
                        if (client.schemaVersion >= 3) {
                            client.sendEvent({
                                source: "device",
                                event: DeviceEvent.downloadVideoData,
                                serialNumber: serialNumber,
                                buffer: chunk as unknown as JSONValue,
                                metadata: { 
                                    videoCodec: VideoCodec[metadata.videoCodec],
                                    videoFPS: metadata.videoFPS,
                                    videoHeight: metadata.videoHeight,
                                    videoWidth: metadata.videoWidth,
                                }
                            });
                        }
                    });
            });
            audiostream.on("data", (chunk: Buffer) => {
                this.clients.clients.filter((cl) => cl.receiveLivestream[serialNumber] === true && cl.isConnected)
                    .forEach((client) => {
                        if (client.schemaVersion >= 3) {
                            client.sendEvent({
                                source: "device",
                                event: DeviceEvent.downloadAudioData,
                                serialNumber: serialNumber,
                                buffer: chunk as unknown as JSONValue,
                                metadata: { 
                                    audioCodec: AudioCodec[metadata.audioCodec],
                                }
                            });
                        }
                    });
            });
        });

        this.clients.driver.on("station download finish", (station: Station, device: Device) => {
            const serialNumber = device.getSerial();
            this.clients.clients.filter((cl) => cl.isConnected)
                .forEach((client) => {
                    if (client.schemaVersion >= 3) {
                        client.sendEvent({
                            source: "device",
                            event: DeviceEvent.downloadFinished,
                            serialNumber: serialNumber,
                        });
                    }
                });
        });

        this.clients.driver.on("station rtsp livestream start", (station: Station, device: Device) => {
            const serialNumber = device.getSerial();
            this.clients.clients.filter((cl) => cl.isConnected)
                .forEach((client) => {
                    if (client.schemaVersion >= 6) {
                        client.sendEvent({
                            source: "device",
                            event: DeviceEvent.rtspLivestreamStarted,
                            serialNumber: serialNumber,
                        });
                    }
                });
        });

        this.clients.driver.on("station rtsp livestream stop", (station: Station, device: Device) => {
            const serialNumber = device.getSerial();
            this.clients.clients.filter((cl) => cl.isConnected)
                .forEach((client) => {
                    if (client.schemaVersion >= 6) {
                        client.sendEvent({
                            source: "device",
                            event: DeviceEvent.rtspLivestreamStopped,
                            serialNumber: serialNumber,
                        });
                    }
                });
        });

    }

    private forwardEvent(data: OutgoingEvent, minSchemaVersion: number, maxSchemaVersion: number = internalSchemaVersion): void {
        // Forward event to all connected clients
        this.clients.clients.forEach((client) => {
            if (client.schemaVersion >= minSchemaVersion && client.schemaVersion <= maxSchemaVersion) {
                this.sendEvent(client, data)
            }
        });
    }

    private sendEvent(client: Client, data: OutgoingEvent): void {
        // Send event to connected client only
        if (client.receiveEvents && client.isConnected) {
            client.sendEvent(data);
        }
    }

    private setupStation(station: Station):void {
        station.on("connect", () => {
            this.forwardEvent({
                source: "station",
                event: StationEvent.connected,
                serialNumber: station.getSerial()
            }, 0);
        });

        station.on("close", () => {
            this.forwardEvent({
                source: "station",
                event: StationEvent.disconnected,
                serialNumber: station.getSerial()
            }, 0);
        });

        station.on("guard mode", (station: Station, guardMode: number) => {
            // Event for schemaVersion <= 2
            this.forwardEvent({
                source: "station",
                event: StationEvent.guardModeChanged,
                serialNumber: station.getSerial(),
                guardMode: guardMode,
                currentMode: station.getCurrentMode().value as number,
            }, 0 , 2);
            // Event for schemaVersion >= 3
            this.forwardEvent({
                source: "station",
                event: StationEvent.guardModeChanged,
                serialNumber: station.getSerial(),
                guardMode: guardMode,
            }, 3);
        });

        station.on("current mode", (station: Station, currentMode: number) => {
            // Event for schemaVersion <= 2
            this.forwardEvent({
                source: "station",
                event: StationEvent.guardModeChanged,
                serialNumber: station.getSerial(),
                guardMode: station.getGuardMode().value as number,
                currentMode: currentMode,
            }, 0, 2);
            //Event for schemaVersion >= 3
            this.forwardEvent({
                source: "station",
                event: StationEvent.currentModeChanged,
                serialNumber: station.getSerial(),
                currentMode: currentMode,
            }, 3);
        });

        station.on("alarm event", (station: Station, alarmEvent: AlarmEvent) => {
            this.forwardEvent({
                source: "station",
                event: StationEvent.alarmEvent,
                serialNumber: station.getSerial(),
                alarmEvent: alarmEvent,
            }, 3);
        });

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        station.on("rtsp url", (station: Station, channel:number, value: string, modified: number) => {
            const device = this.clients.driver.getStationDevice(station.getSerial(), channel);
            this.forwardEvent({
                source: "device",
                event: DeviceEvent.gotRtspUrl,
                serialNumber: device.getSerial(),
                rtspUrl: value,
            }, 0);
        });

        station.on("command result", (station: Station, result: CommandResult) => {
            //TODO: Implement this event differently or remove the commands already implemented as properties
            if (result.channel === Station.CHANNEL) {
                //Station command result
                let command: string | undefined = undefined;
                switch (result.command_type) {
                    case CommandType.CMD_HUB_REBOOT:
                        command = StationCommand.reboot;
                        break;
                    case CommandType.CMD_SET_ARMING:
                        command = StationCommand.setGuardMode;
                        break;
                    case CommandType.CMD_SET_TONE_FILE:
                        command = StationCommand.triggerAlarm;
                        break;
                }
                if (command !== undefined) {
                    this.forwardEvent({
                        source: "station",
                        event: StationEvent.commandResult,
                        serialNumber: station.getSerial(),
                        command: command.split(".")[1],
                        returnCode: result.return_code,
                        returnCodeName: ErrorCode[result.return_code] !== undefined ? ErrorCode[result.return_code] : "UNKNOWN",
                    }, 0);
                }
            } else {
                // Device command result
                let command: string | undefined = undefined;
                switch (result.command_type as number) {
                    case CommandType.CMD_DEVS_SWITCH:
                        command = DeviceCommand.enableDevice;
                        break;
                    case CommandType.CMD_DOORLOCK_DATA_PASS_THROUGH:
                        command = DeviceCommand.lockDevice;
                        break;
                    case CommandType.CMD_EAS_SWITCH:
                        command = DeviceCommand.setAntiTheftDetection;
                        break;
                    case CommandType.CMD_IRCUT_SWITCH:
                        command = DeviceCommand.setAutoNightVision;
                        break;
                    case CommandType.CMD_PIR_SWITCH:
                    case CommandType.CMD_INDOOR_DET_SET_MOTION_DETECT_ENABLE:
                    case ParamType.COMMAND_MOTION_DETECTION_PACKAGE:
                        command = DeviceCommand.setMotionDetection;
                        break;
                    case CommandType.CMD_INDOOR_DET_SET_PET_ENABLE:
                        command = DeviceCommand.setPetDetection;
                        break;
                    case CommandType.CMD_NAS_SWITCH:
                        command = DeviceCommand.setRTSPStream;
                        break;
                    case CommandType.CMD_INDOOR_DET_SET_SOUND_DETECT_ENABLE:
                        command = DeviceCommand.setSoundDetection;
                        break;
                    case CommandType.CMD_DEV_LED_SWITCH:
                    case CommandType.CMD_INDOOR_LED_SWITCH:
                    case CommandType.CMD_BAT_DOORBELL_SET_LED_ENABLE:
                    case ParamType.COMMAND_LED_NIGHT_OPEN:
                        command = DeviceCommand.setStatusLed;
                        break;
                    case CommandType.CMD_SET_DEVS_OSD:
                        command = DeviceCommand.setWatermark;
                        break;
                    case CommandType.CMD_INDOOR_ROTATE:
                        command = DeviceCommand.panAndTilt;
                        break;
                    case CommandType.CMD_SET_DEVS_TONE_FILE:
                        command = DeviceCommand.triggerAlarm;
                        break;
                    case CommandType.CMD_DOWNLOAD_VIDEO:
                        command = DeviceCommand.startDownload;
                        break;
                    case CommandType.CMD_DOWNLOAD_CANCEL:
                        command = DeviceCommand.cancelDownload;
                        break;
                    case CommandType.CMD_START_REALTIME_MEDIA:
                    case ParamType.COMMAND_START_LIVESTREAM:
                        command = DeviceCommand.startLivestream;
                        break;
                    case CommandType.CMD_STOP_REALTIME_MEDIA:
                        command = DeviceCommand.stopLivestream;
                        break;
                    case CommandType.CMD_BAT_DOORBELL_QUICK_RESPONSE:
                    //case 1004: //TODO: CMD_STOP_REALTIME_MEDIA has the same number
                        command = DeviceCommand.quickResponse;
                        break;
                }
                if (command !== undefined) {
                    const device = this.clients.driver.getStationDevice(station.getSerial(), result.channel);
                    this.forwardEvent({
                        source: "device",
                        event: DeviceEvent.commandResult,
                        serialNumber: device.getSerial(),
                        command: command.split(".")[1],
                        returnCode: result.return_code,
                        returnCodeName: ErrorCode[result.return_code] !== undefined ? ErrorCode[result.return_code] : "UNKNOWN",
                    }, 0);
                }
            }
        });

        station.on("property changed", (station: Station, name: string, value: PropertyValue) => {
            this.forwardEvent({
                source: "station",
                event: StationEvent.propertyChanged,
                serialNumber: station.getSerial(),
                name: name,
                value: value.value as JSONValue,
                timestamp: value.timestamp
            }, 0);
        });

    }

    private setupDevice(device: Device): void {
        if (device instanceof Camera) {
            device.on("motion detected", (device: Device, state: boolean) => {
                this.clients.clients.forEach((client) =>
                    this.sendEvent(client, {
                        source: "device",
                        event: DeviceEvent.motionDetected,
                        serialNumber: device.getSerial(),
                        state: state,
                    })
                );
            });

            device.on("person detected", (device: Device, state: boolean, person: string) => {
                this.clients.clients.forEach((client) =>
                    this.sendEvent(client, {
                        source: "device",
                        event: DeviceEvent.personDetected,
                        serialNumber: device.getSerial(),
                        state: state,
                        person: person,
                    })
                );
            });
        } else if (device instanceof IndoorCamera) {
            device.on("crying detected", (device: Device, state: boolean) => {
                this.clients.clients.forEach((client) =>
                    this.sendEvent(client, {
                        source: "device",
                        event: DeviceEvent.cryingDetected,
                        serialNumber: device.getSerial(),
                        state: state
                    })
                );
            });
    
            device.on("pet detected", (device: Device, state: boolean) => {
                this.clients.clients.forEach((client) =>
                    this.sendEvent(client, {
                        source: "device",
                        event: DeviceEvent.petDetected,
                        serialNumber: device.getSerial(),
                        state: state,
                    })
                );
            });
    
            device.on("sound detected", (device: Device, state: boolean) => {
                this.clients.clients.forEach((client) =>
                    this.sendEvent(client, {
                        source: "device",
                        event: DeviceEvent.soundDetected,
                        serialNumber: device.getSerial(),
                        state: state,
                    })
                );
            });
        } else if (device instanceof DoorbellCamera) {
            device.on("rings", (device: Device, state: boolean) => {
                this.clients.clients.forEach((client) =>
                    this.sendEvent(client, {
                        source: "device",
                        event: DeviceEvent.rings,
                        serialNumber: device.getSerial(),
                        state: state,
                    })
                );
            });
        } else if (device instanceof EntrySensor) {
            device.on("open", (device: Device, state: boolean) => {
                this.clients.clients.forEach((client) =>
                    this.sendEvent(client, {
                        source: "device",
                        event: DeviceEvent.sensorOpen,
                        serialNumber: device.getSerial(),
                        state: state,
                    })
                );
            });
        } else if (device instanceof MotionSensor) {
            device.on("motion detected", (device: Device, state: boolean) => {
                this.clients.clients.forEach((client) =>
                    this.sendEvent(client, {
                        source: "device",
                        event: DeviceEvent.motionDetected,
                        serialNumber: device.getSerial(),
                        state: state,
                    })
                );
            });
        }

        device.on("property changed", (device: Device, name: string, value: PropertyValue) => {
            this.forwardEvent({
                source: "device",
                event: DeviceEvent.propertyChanged,
                serialNumber: device.getSerial(),
                name: name,
                value: value.value as JSONValue,
                timestamp: value.timestamp
            }, 0);
        });
    }

}
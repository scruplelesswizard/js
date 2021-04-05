import { Protobuf, Types } from "./";
import { IMeshDevice } from "./imeshdevice";
import { log, typedArrayToBuffer } from "./utils";

/**
 * Allows to connect to a meshtastic device over HTTP(S)
 */
export class IHTTPConnection extends IMeshDevice {
  /**
   * URL of the device that is to be connected to.
   */
  url: string;

  /**
   * Enables receiving messages all at once, versus one per request
   */
  receiveBatchRequests: boolean;

  constructor() {
    super();

    this.url = undefined;

    this.receiveBatchRequests = false;
  }

  /**
   * Initiates the connect process to a meshtastic device via HTTP(S)
   * @param address The IP Address/Domain to connect to, without protocol
   * @param tls Enables transport layer security. Notes: Slower, devices' certificate must be trusted by the browser
   * @param receiveBatchRequests Enables receiving messages all at once, versus one per request
   * @param fetchInterval (ms) Sets a fixed interval in that the device is fetched for new messages, defaults to 5 seconds
   */
  public async connect(
    address: string,
    tls?: boolean,
    receiveBatchRequests?: boolean,
    fetchInterval = 5000
  ) {
    this.onDeviceStatusEvent.next(Types.DeviceStatusEnum.DEVICE_CONNECTING);

    this.receiveBatchRequests = receiveBatchRequests;

    if (!this.url) {
      this.url = tls ? `https://${address}` : `http://${address}`;
    }
    if (await this.ping()) {
      log(
        `IHTTPConnection.connect`,
        `Ping succeeded, starting new request timer.`,
        Protobuf.LogLevelEnum.DEBUG
      );
      setInterval(async () => {
        await this.readFromRadio().catch((e) => {
          log(`IHTTPConnection`, e, Protobuf.LogLevelEnum.ERROR);
        });
      }, fetchInterval);
    } else {
      setTimeout(() => {
        this.connect(address, tls, receiveBatchRequests, fetchInterval);
      }, 10000);
    }
  }

  /**
   * Disconnects from the meshtastic device
   */
  public disconnect() {
    this.onDeviceStatusEvent.next(Types.DeviceStatusEnum.DEVICE_DISCONNECTED);
  }

  /**
   * Pings device to check if it is avaliable
   */
  public async ping() {
    log(
      `IHTTPConnection.connect`,
      `Attempting device ping.`,
      Protobuf.LogLevelEnum.DEBUG
    );

    let pingSuccessful = false;

    await fetch(this.url + `/hotspot-detect.html`, {})
      .then(async (_) => {
        pingSuccessful = true;
        this.onDeviceStatusEvent.next(Types.DeviceStatusEnum.DEVICE_CONNECTED);

        await this.configure();
      })
      .catch((e) => {
        pingSuccessful = false;
        log(`IHTTPConnection.connect`, e.message, Protobuf.LogLevelEnum.ERROR);
        this.onDeviceStatusEvent.next(
          Types.DeviceStatusEnum.DEVICE_RECONNECTING
        );
      });
    return pingSuccessful;
  }

  /**
   * Reads any avaliable protobuf messages from the radio
   */
  protected async readFromRadio() {
    let readBuffer = new ArrayBuffer(1);

    while (readBuffer.byteLength > 0) {
      await fetch(
        this.url + `/api/v1/fromradio?all=${this.receiveBatchRequests}`,
        {
          method: "GET",
          headers: {
            Accept: "application/x-protobuf"
          }
        }
      )
        .then(async (response) => {
          /**
           * @todo, is the DEVICE_CONNECTED event duplicated here, why are we checking for the connection status.
           */
          this.onDeviceStatusEvent.next(
            Types.DeviceStatusEnum.DEVICE_CONNECTED
          );

          if (this.deviceStatus < Types.DeviceStatusEnum.DEVICE_CONNECTED) {
            this.onDeviceStatusEvent.next(
              Types.DeviceStatusEnum.DEVICE_CONNECTED
            );
          }

          readBuffer = await response.arrayBuffer();

          if (readBuffer.byteLength > 0) {
            await this.handleFromRadio(new Uint8Array(readBuffer, 0));
          }
        })
        .catch((e) => {
          log(
            `IHTTPConnection.readFromRadio`,
            e.message,
            Protobuf.LogLevelEnum.ERROR
          );

          if (
            this.deviceStatus !== Types.DeviceStatusEnum.DEVICE_RECONNECTING
          ) {
            this.onDeviceStatusEvent.next(
              Types.DeviceStatusEnum.DEVICE_RECONNECTING
            );
          }
        });
    }
  }

  /**
   * Sends supplied protobuf message to the radio
   */
  protected async writeToRadio(ToRadioUInt8Array: Uint8Array) {
    await fetch(`${this.url}/api/v1/toradio`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/x-protobuf"
      },
      body: typedArrayToBuffer(ToRadioUInt8Array)
    })
      .then(async (_) => {
        this.onDeviceStatusEvent.next(Types.DeviceStatusEnum.DEVICE_CONNECTED);

        await this.readFromRadio().catch((e) => {
          log(`IHTTPConnection`, e, Protobuf.LogLevelEnum.ERROR);
        });
      })
      .catch((e) => {
        log(
          `IHTTPConnection.writeToRadio`,
          e.message,
          Protobuf.LogLevelEnum.ERROR
        );
        this.onDeviceStatusEvent.next(
          Types.DeviceStatusEnum.DEVICE_RECONNECTING
        );
      });
  }

  /**
   * Web API method: Restart device
   */
  public async restartDevice() {
    return fetch(`${this.url}/restart`, {
      method: "POST"
    })
      .then(() => {
        this.onDeviceStatusEvent.next(Types.DeviceStatusEnum.DEVICE_RESTARTING);
      })
      .catch((e) => {
        log(
          `IHTTPConnection.restartDevice`,
          e.message,
          Protobuf.LogLevelEnum.ERROR
        );
      });
  }

  /**
   * Web API method: Get airtime statistics
   */
  public async getStatistics() {
    return fetch(`${this.url}/json/report`, {
      method: "GET"
    })
      .then(async (response) => {
        return (await response.json()) as Types.WebStatisticsResponse;
      })
      .catch((e) => {
        log(
          `IHTTPConnection.getStatistics`,
          e.message,
          Protobuf.LogLevelEnum.ERROR
        );
      });
  }

  /**
   * Web API method: Scan for WiFi AP's
   */
  public async getNetworks() {
    return fetch(`${this.url}/json/scanNetworks`, {
      method: "GET"
    })
      .then(async (response) => {
        return (await response.json()) as Types.WebNetworkResponse;
      })
      .catch((e) => {
        log(
          `IHTTPConnection.getNetworks`,
          e.message,
          Protobuf.LogLevelEnum.ERROR
        );
      });
  }

  /**
   * Web API method: Fetch SPIFFS contents
   */
  public async getSPIFFS() {
    return fetch(`${this.url}/json/spiffs/browse/static`, {
      method: "GET"
    })
      .then(async (response) => {
        return (await response.json()) as Types.WebSPIFFSResponse;
      })
      .catch((e) => {
        log(
          `IHTTPConnection.getSPIFFS`,
          e.message,
          Protobuf.LogLevelEnum.ERROR
        );
      });
  }

  /**
   * Web API method: Delete SPIFFS file
   */
  public async deleteSPIFFS(file: string) {
    return fetch(
      `${this.url}/json/spiffs/delete/static?${new URLSearchParams({
        delete: file
      })}`,
      {
        method: "DELETE"
      }
    )
      .then(async (response) => {
        return (await response.json()) as Types.WebSPIFFSResponse;
      })
      .catch((e) => {
        log(
          `IHTTPConnection.deleteSPIFFS`,
          e.message,
          Protobuf.LogLevelEnum.ERROR
        );
      });
  }

  /**
   * Web API method: Make device LED blink
   * @todo, strongly type response
   */
  public async blinkLED() {
    return fetch(`${this.url}/json/blink`, {
      method: "POST"
    }).catch((e) => {
      log(`IHTTPConnection.blinkLED`, e.message, Protobuf.LogLevelEnum.ERROR);
    });
  }
}

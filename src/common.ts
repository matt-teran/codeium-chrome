import { Code, ConnectError, PromiseClient, createPromiseClient } from '@bufbuild/connect';
import { createConnectTransport } from '@bufbuild/connect-web';
import { PartialMessage } from '@bufbuild/protobuf';
import { v4 as uuidv4 } from 'uuid';

import { Storage } from './storage';
import { Metadata } from '../proto/exa/codeium_common_pb/codeium_common_pb';
import { LanguageServerService } from '../proto/exa/language_server_pb/language_server_connect';
import {
  AcceptCompletionRequest,
  GetCompletionsRequest,
  GetCompletionsResponse,
} from '../proto/exa/language_server_pb/language_server_pb';

const EXTENSION_NAME = 'chrome';
const EXTENSION_VERSION = '1.2.26';

export const CODEIUM_DEBUG = false;

async function getApiKey(extensionId: string): Promise<string | undefined> {
  const user = await new Promise<Storage['user']>((resolve) => {
    chrome.runtime.sendMessage(extensionId, { type: 'user' }, (response: Storage['user']) => {
      resolve(response);
    });
  });
  return user?.apiKey;
}

function languageServerClient(baseUrl: string): PromiseClient<typeof LanguageServerService> {
  const transport = createConnectTransport({
    baseUrl,
    useBinaryFormat: true,
  });
  return createPromiseClient(LanguageServerService, transport);
}

class ApiKeyPoller {
  // This is initialized to a promise at construction, then updated to a
  // non-promise later.
  apiKey: Promise<string | undefined> | string | undefined;
  constructor(extensionId: string) {
    this.apiKey = getApiKey(extensionId);
    setInterval(async () => {
      this.apiKey = await getApiKey(extensionId);
    }, 500);
  }
}

export interface IdeInfo {
  ideName: string;
  ideVersion: string;
}

export class LanguageServerServiceWorkerClient {
  // Note that the URL won't refresh post-initialization.
  client: Promise<PromiseClient<typeof LanguageServerService>>;
  private abortController?: AbortController;

  constructor(baseUrlPromise: Promise<string>, private readonly sessionId: string) {
    this.client = (async (): Promise<PromiseClient<typeof LanguageServerService>> => {
      return languageServerClient(await baseUrlPromise);
    })();
  }

  getHeaders(apiKey: string | undefined): Record<string, string> {
    if (apiKey === undefined) {
      return {};
    }
    const Authorization = `Basic ${apiKey}-${this.sessionId}`;
    return { Authorization };
  }

  async getCompletions(
    request: GetCompletionsRequest
  ): Promise<GetCompletionsResponse | undefined> {
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const getCompletionsPromise = (await this.client).getCompletions(request, {
      signal,
      headers: this.getHeaders(request.metadata?.apiKey),
    });
    try {
      return await getCompletionsPromise;
    } catch (err) {
      if (signal.aborted) {
        return;
      }
      if (err instanceof ConnectError) {
        if (err.code != Code.Canceled) {
          console.log(err.message);
          await chrome.runtime.sendMessage(chrome.runtime.id, {
            type: 'error',
            message: err.message,
          });
        }
      } else {
        console.log((err as Error).message);
        await chrome.runtime.sendMessage(chrome.runtime.id, {
          type: 'error',
          message: (err as Error).message,
        });
      }
      return;
    }
  }

  async acceptedLastCompletion(
    acceptCompletionRequest: PartialMessage<AcceptCompletionRequest>
  ): Promise<void> {
    try {
      await (
        await this.client
      ).acceptCompletion(acceptCompletionRequest, {
        headers: this.getHeaders(acceptCompletionRequest.metadata?.apiKey),
      });
    } catch (err) {
      console.log((err as Error).message);
    }
  }
}

interface GetCompletionsRequestMessage {
  kind: 'getCompletions';
  requestId: number;
  request: string;
}

interface AcceptCompletionRequestMessage {
  kind: 'acceptCompletion';
  request: string;
}

export type LanguageServerWorkerRequest =
  | GetCompletionsRequestMessage
  | AcceptCompletionRequestMessage;

export interface GetCompletionsResponseMessage {
  kind: 'getCompletions';
  requestId: number;
  response?: string;
}

export type LanguageServerWorkerResponse = GetCompletionsResponseMessage;

export class LanguageServerClient {
  private sessionId = uuidv4();
  private port: chrome.runtime.Port;
  private requestId = 0;
  private promiseMap = new Map<number, (res: GetCompletionsResponse | undefined) => void>();
  apiKeyPoller: ApiKeyPoller;

  constructor(readonly extensionId: string) {
    this.port = this.createPort();
    this.apiKeyPoller = new ApiKeyPoller(extensionId);
  }

  createPort(): chrome.runtime.Port {
    const port = chrome.runtime.connect(this.extensionId, { name: this.sessionId });
    port.onDisconnect.addListener(() => {
      this.port = this.createPort();
    });
    port.onMessage.addListener(async (message: LanguageServerWorkerResponse) => {
      if (message.kind === 'getCompletions') {
        let res: GetCompletionsResponse | undefined = undefined;
        if (message.response !== undefined) {
          res = GetCompletionsResponse.fromJsonString(message.response);
        }
        this.promiseMap.get(message.requestId)?.(res);
        this.promiseMap.delete(message.requestId);
      }
    });
    return port;
  }

  getMetadata(ideInfo: IdeInfo, apiKey: string): Metadata {
    return new Metadata({
      ideName: ideInfo.ideName,
      ideVersion: ideInfo.ideVersion,
      extensionName: EXTENSION_NAME,
      extensionVersion: EXTENSION_VERSION,
      apiKey,
      locale: navigator.language,
      sessionId: this.sessionId,
      requestId: BigInt(++this.requestId),
      userAgent: navigator.userAgent,
      url: window.location.href,
    });
  }

  async getCompletions(
    request: GetCompletionsRequest
  ): Promise<GetCompletionsResponse | undefined> {
    const requestId = Number(request.metadata?.requestId);
    const prom = new Promise<GetCompletionsResponse | undefined>((resolve) => {
      this.promiseMap.set(requestId, resolve);
    });
    const message: GetCompletionsRequestMessage = {
      kind: 'getCompletions',
      requestId,
      request: request.toJsonString(),
    };
    this.port.postMessage(message);
    return prom;
  }

  acceptedLastCompletion(ideInfo: IdeInfo, apiKey: string, completionId: string): void {
    const request = new AcceptCompletionRequest({
      metadata: this.getMetadata(ideInfo, apiKey),
      completionId,
    });
    const message: AcceptCompletionRequestMessage = {
      kind: 'acceptCompletion',
      request: request.toJsonString(),
    };
    this.port.postMessage(message);
  }
}

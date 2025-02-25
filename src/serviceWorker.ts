import { v4 as uuidv4 } from 'uuid';

import { registerUser } from './auth';
import {
  GetCompletionsResponseMessage,
  LanguageServerServiceWorkerClient,
  LanguageServerWorkerRequest,
} from './common';
import { loggedIn, loggedOut, unhealthy } from './shared';
import {
  defaultAllowlist,
  getGeneralPortalUrl,
  getStorageItem,
  initializeStorageWithDefaults,
  setStorageItem,
} from './storage';
import {
  AcceptCompletionRequest,
  GetCompletionsRequest,
} from '../proto/exa/language_server_pb/language_server_pb';

const authStates: string[] = [];

chrome.runtime.onInstalled.addListener(async () => {
  // Here goes everything you want to execute after extension initialization

  await initializeStorageWithDefaults({
    settings: {},
    allowlist: { defaults: defaultAllowlist, current: defaultAllowlist },
  });

  console.log('Extension successfully installed!');

  if ((await getStorageItem('user'))?.apiKey === undefined) {
    // TODO(prem): Is this necessary?
    await loggedOut();
    // Inline the code for openAuthTab() because we can't invoke sendMessage.
    const uuid = uuidv4();
    authStates.push(uuid);
    const portalUrl = await (async (): Promise<string> => {
      const url = await getGeneralPortalUrl();
      if (url === undefined) {
        return 'https://www.codeium.com';
      }
      return url;
    })();
    await chrome.tabs.create({
      url: `${portalUrl}/profile?redirect_uri=chrome-extension://${chrome.runtime.id}&state=${uuid}`,
    });
  } else {
    await loggedIn();
  }
});

// The only external messages:
//  - website auth
//  - request for api key
//  - set icon and error message
chrome.runtime.onMessageExternal.addListener(async (message, sender, sendResponse) => {
  if (message.type === 'user') {
    const user = await getStorageItem('user');
    sendResponse(user);
    if (user?.apiKey === undefined) {
      await loggedOut();
    }
    return;
  }
  if (message.type === 'allowlist') {
    const allowlist = await getStorageItem('allowlist');
    sendResponse(allowlist);
    return;
  }
  if (message.type == 'error') {
    await unhealthy(message.message);
    return;
  }
  if (message.type == 'success') {
    await loggedIn();
    return;
  }
  if (typeof message.token !== 'string' || typeof message.state !== 'string') {
    console.log('Unexpected message:', message);
    return;
  }
  const typedMessage = message as { token: string; state: string };
  const stateIndex = authStates.indexOf(typedMessage.state);
  if (stateIndex === -1) {
    console.log('Unexpected state:', typedMessage.state);
    return;
  }
  authStates.splice(stateIndex, 1);
  await login(typedMessage.token);
});

chrome.runtime.onStartup.addListener(async () => {
  if ((await getStorageItem('user'))?.apiKey === undefined) {
    await loggedOut();
  } else {
    await loggedIn();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  // TODO(prem): Strongly type this.
  if (message.type === 'state') {
    const payload = message.payload as { state: string };
    authStates.push(payload.state);
  } else if (message.type === 'manual') {
    login(message.token);
  } else {
    console.log('Unrecognized message:', message);
  }
});

const clientMap = new Map<string, LanguageServerServiceWorkerClient>();

// TODO(prem): Is it safe to make this listener async to simplify the LanguageServerServiceWorkerClient constructor?
chrome.runtime.onConnectExternal.addListener((port) => {
  // TODO(prem): Technically this URL isn't synchronized with the user/API key.
  clientMap.set(
    port.name,
    new LanguageServerServiceWorkerClient(getLanguageServerUrl(), port.name)
  );
  port.onDisconnect.addListener((port) => {
    clientMap.delete(port.name);
  });
  port.onMessage.addListener(async (message: LanguageServerWorkerRequest, port) => {
    const client = clientMap.get(port.name);
    if (message.kind === 'getCompletions') {
      const response = await client?.getCompletions(
        GetCompletionsRequest.fromJsonString(message.request)
      );
      const reply: GetCompletionsResponseMessage = {
        kind: 'getCompletions',
        requestId: message.requestId,
        response: response?.toJsonString(),
      };
      port.postMessage(reply);
    } else if (message.kind == 'acceptCompletion') {
      await client?.acceptedLastCompletion(AcceptCompletionRequest.fromJsonString(message.request));
    } else {
      console.log('Unrecognized message:', message);
    }
  });
});

async function login(token: string) {
  try {
    const portalUrl = await getGeneralPortalUrl();
    const user = await registerUser(token, portalUrl);
    await setStorageItem('user', {
      apiKey: user.api_key,
      name: user.name,
      userPortalUrl: portalUrl,
    });
    await loggedIn();
    // TODO(prem): Open popup.
    // https://github.com/GoogleChrome/developer.chrome.com/issues/2602
    // await chrome.action.openPopup();
  } catch (error) {
    console.log(error);
  }
}

async function getLanguageServerUrl(): Promise<string> {
  const user = await getStorageItem('user');
  const userPortalUrl = user?.userPortalUrl;
  if (userPortalUrl === undefined || userPortalUrl === '') {
    return 'https://server.codeium.com';
  }
  return `${userPortalUrl}/_route/language_server`;
}

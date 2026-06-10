#!/usr/bin/env node
import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { RpcRequest, RpcResponse, RpcMethod } from '../shared/rpc';
import { getPipeName, getAuthTokenPath } from '../shared/constants';

// 서버(PipeServer)와 동일한 경로 해석을 사용한다. 과거에는 '/tmp/wmux.sock'을
// 하드코딩해 macOS/Linux에서 서버('~/.wmux.sock')와 어긋나 항상 "not running"이
// 떴고, Windows에서도 username 없는 '\\.\pipe\wmux'로 빗나갔다. getPipeName()이
// win32/unix·username을 모두 처리한다. WMUX_SOCKET_PATH로 오버라이드 가능.
const PIPE_NAME = process.env.WMUX_SOCKET_PATH || getPipeName();
const TIMEOUT_MS = 5000;

// 인증 토큰: 서버는 토큰을 ~/.wmux-auth-token 파일에 쓴다. CLI가 이 파일을
// 자동으로 읽지 않아 매번 WMUX_AUTH_TOKEN을 수동 주입해야 했다(인증 실패).
// env 우선, 없으면 토큰 파일에서 읽는다.
function resolveAuthToken(): string | undefined {
  if (process.env.WMUX_AUTH_TOKEN) return process.env.WMUX_AUTH_TOKEN;
  try {
    const fromFile = fs.readFileSync(getAuthTokenPath(), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch {
    // 파일 없음/권한 없음 — 토큰 없이 진행(서버가 거부하면 호출부에서 처리)
  }
  return undefined;
}

export function sendRequest(
  method: RpcMethod,
  params: Record<string, unknown> = {}
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const token = resolveAuthToken();
    const request: RpcRequest = { id, method, params, token };

    const socket = net.connect(PIPE_NAME);
    let buffer = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error('Request timed out after 5 seconds.'));
      }
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const response = JSON.parse(trimmed) as RpcResponse;
          if (response.id === id && !settled) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(response);
          }
        } catch {
          // ignore malformed lines
        }
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new Error('wmux is not running. Start the app first.'));
        } else {
          reject(new Error(`Connection error: ${err.message}`));
        }
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Connection closed before response was received.'));
      }
    });
  });
}

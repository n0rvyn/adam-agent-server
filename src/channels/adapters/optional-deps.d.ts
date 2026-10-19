// Type stubs for optional channel adapter dependencies.
// These packages are installed only when the corresponding channel is enabled.

declare module "silk-wasm" {
  export function decode(input: Buffer, sampleRate: number): Promise<{
    data: Uint8Array;
    duration: number;
  }>;
}

declare module "grammy" {
  export class Bot {
    constructor(token: string);
    on(event: string, handler: (ctx: any) => void): void;
    start(options?: any): Promise<void>;
    stop(): Promise<void>;
    api: { sendMessage(chatId: string, text: string, options?: any): Promise<any>; sendChatAction(chatId: string, action: string): Promise<any> };
  }
  export type Context = any;
}

declare module "@slack/bolt" {
  export class App {
    constructor(options: any);
    start(port?: number): Promise<void>;
    stop(): Promise<void>;
    message(handler: (args: any) => void): void;
    client: { chat: { postMessage(args: any): Promise<any>; update(args: any): Promise<any>; delete(args: any): Promise<any> } };
  }
}

declare module "discord.js" {
  export class Client {
    constructor(options: any);
    login(token: string): Promise<string>;
    destroy(): Promise<void>;
    on(event: string, handler: (...args: any[]) => void): this;
    user: { id: string } | null;
    channels: { fetch(id: string): Promise<any> };
  }
  export const GatewayIntentBits: Record<string, number>;
  export const Partials: Record<string, number>;
  export class TextChannel { send(content: any): Promise<any>; messages: { fetch(id: string): Promise<any> }; sendTyping(): Promise<void> }
  export class Message { content: string; author: { id: string; username: string; bot: boolean }; channel: { id: string }; id: string; reply(content: any): Promise<any>; edit(content: any): Promise<any>; delete(): Promise<any> }
  export class DMChannel extends TextChannel {}
  export type ReplyOptions = any;
}

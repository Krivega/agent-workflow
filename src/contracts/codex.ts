export interface CodexRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  completed(thread: string, turn: string, signal?: AbortSignal): Promise<void>;
}

import { execa } from "execa";

export type CommandRunner = {
  execute: boolean;
  run(command: string, args: string[], options?: { cwd?: string }): Promise<string>;
  json<T>(command: string, args: string[], options?: { cwd?: string }): Promise<T>;
};

export function createCommandRunner(execute: boolean): CommandRunner {
  return {
    execute,
    async run(command: string, args: string[], options?: { cwd?: string }) {
      const printable = [command, ...args].join(" ");
      if (!execute) {
        console.log(`[dry-run] ${options?.cwd ? `(cd ${options.cwd} && ${printable})` : printable}`);
        return "";
      }

      const result = await execa(command, args, {
        cwd: options?.cwd,
        reject: true,
        all: true
      });
      return result.all ?? result.stdout;
    },
    async json<T>(command: string, args: string[], options?: { cwd?: string }) {
      const output = await this.run(command, args, options);
      if (!execute) return {} as T;
      return JSON.parse(output) as T;
    }
  };
}

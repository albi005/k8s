import { $ } from "bun";

export type ShellCmd = ReturnType<typeof $>;

export async function check(cmd: ShellCmd): Promise<void> {
    const result = await cmd.nothrow();
    if (result.exitCode !== 0) {
        console.error("✗ command failed");
        process.exit(1);
    }
}

export async function ok(cmd: ShellCmd): Promise<boolean> {
    return (await cmd.quiet().nothrow()).exitCode === 0;
}

export async function text(cmd: ShellCmd): Promise<string> {
    return (await cmd.quiet().nothrow().text()).trim();
}

export function have(cmd: string): Promise<boolean> {
    return ok($`which ${cmd}`);
}

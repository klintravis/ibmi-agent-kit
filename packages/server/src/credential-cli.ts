// `ibmi-agent-kit credential set|delete <profile>`: keeps the OS store entry of a profile's user and
// host. The password comes from a hidden prompt, or one line of a piped stdin, never from argv; no
// command prints a stored password and the profile file is never changed. Returns the exit code:
// 0 done, 2 a usage error or store failure, 130 cancelled.
import { credentialAccount, deleteStoredSecret, resolveProfileEnv, setCredentialStore, storeSecret, type CredentialStore } from "@ibmi-agent-kit/core";
import { Cancelled, reader, type Input, type Write } from "./setup-cli.js";
import { message } from "./profile-write.js";

export interface CredentialDeps {
  input: Input;
  out: Write;
  err: Write;
  store?: CredentialStore; // default the OS store
}

const USAGE = "usage: ibmi-agent-kit credential set|delete <profile>\n(the password is asked for, never given on the command line)\n";

// One line of a piped stdin, without its line ending.
const line = (input: Input) =>
  new Promise<string>((done) => {
    let text = "";
    const finish = () => {
      input.off("data", onData);
      input.off("end", finish);
      input.pause();
      done(text.split(/\r?\n/)[0]);
    };
    const onData = (chunk: string) => {
      text += chunk;
      if (text.includes("\n")) finish();
    };
    input.setEncoding("utf8");
    input.on("data", onData);
    input.once("end", finish);
    input.resume();
  });

export async function credentialCli(args: string[], deps: CredentialDeps): Promise<number> {
  const { input, out, err } = deps;
  const [verb, name, ...extra] = args;
  if ((verb !== "set" && verb !== "delete") || !name || extra.length) return err(USAGE), 2;
  if (deps.store) setCredentialStore(deps.store);

  let env: Record<string, string>;
  try {
    env = resolveProfileEnv(name);
  } catch (e) {
    return err(`${message(e)}\n`), 2;
  }
  const user = env.IBMI_USER?.trim();
  const host = env.IBMI_HOST?.trim();
  if (!user || !host) return err(`profile "${name}" sets no ${[!host && "IBMI_HOST", !user && "IBMI_USER"].filter(Boolean).join(" and no ")}. Nothing was changed.\n`), 2;
  const account = credentialAccount(user, host);
  if (env.IBMI_PASSWORD_STORE !== "os") {
    err(`note: profile "${name}" does not set IBMI_PASSWORD_STORE=os, so the kit will not read this entry. Run \`ibmi-agent-kit setup ${name}\` to choose the OS store.\n`);
  }

  try {
    if (verb === "delete") {
      out((await deleteStoredSecret(user, host)) ? `removed the stored password for ${account}\n` : `no stored password for ${account}\n`);
      return 0;
    }
    let secret: string;
    if (input.isTTY && input.setRawMode) secret = await reader(input, out)(`password for ${account}: `, true);
    else secret = await line(input);
    if (!secret) return err("no password given. Nothing was stored.\n"), 2;
    await storeSecret(user, host, secret);
    out(`stored the password for ${account}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Cancelled) return err("cancelled, nothing stored\n"), 130;
    return err(`${message(e)}\n`), 2;
  }
}

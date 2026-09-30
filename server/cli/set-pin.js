'use strict';

// Usage: npm run set-pin            (interactive, input hidden)
//        echo 1234 | npm run set-pin (non-interactive, e.g. in scripts)
// Stores a scrypt hash of the PIN in the secrets file. Existing sessions are
// invalidated because the session fingerprint depends on the PIN.

const readline = require('readline');
const { t, secretsFile, loadSecretsFile, saveSecretsFile } = require('../config');
const { hashPin, validatePinFormat } = require('../auth');
const { config } = require('../config');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      // Mask typed characters.
      rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? question : '*'.repeat(s.length ? 1 : 0));
    }
    rl.question(question, (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const pin = await ask(t('server.cli.enterPin'));
  if (!validatePinFormat(pin)) {
    console.error(t('server.cli.pinInvalid', { min: config.auth.pinMinLength, max: config.auth.pinMaxLength }));
    process.exit(1);
  }
  if (process.stdin.isTTY) {
    const again = await ask(t('server.cli.confirmPin'));
    if (again !== pin) {
      console.error(t('server.cli.pinMismatch'));
      process.exit(1);
    }
  }
  const data = loadSecretsFile();
  data.pinHash = await hashPin(pin);
  saveSecretsFile(data);
  console.log(t('server.cli.pinSaved', { file: secretsFile }));
}

main();

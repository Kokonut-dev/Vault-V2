#!/usr/bin/env node
/**
 * Generate self-signed certificate for local HTTPS
 * Uses mkcert if available, otherwise openssl or Node.js crypto
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const certDir = path.join(__dirname, '../server/certs');
fs.ensureDirSync(certDir);

console.log('Generating self-signed certificate for Vault...\n');

function tryMkcert() {
  try {
    execSync('which mkcert', { stdio: 'ignore' });
    console.log('Found mkcert — using it for trusted local cert');
    execSync(`mkcert -key-file ${path.join(certDir, 'key.pem')} -cert-file ${path.join(certDir, 'cert.pem')} localhost 127.0.0.1 ::1`, { stdio: 'inherit' });
    console.log('\n✓ Certificates generated with mkcert (trusted)');
    console.log(`  Key: ${path.join(certDir, 'key.pem')}`);
    console.log(`  Cert: ${path.join(certDir, 'cert.pem')}`);
    return true;
  } catch {
    return false;
  }
}

function tryOpenssl() {
  try {
    execSync('which openssl', { stdio: 'ignore' });
    console.log('Found openssl — generating self-signed cert');
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    execSync(`openssl req -x509 -newkey rsa:4096 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/CN=localhost"`, { stdio: 'inherit' });
    console.log('\n✓ Certificates generated with openssl (self-signed, needs manual trust)');
    console.log(`  Key: ${keyPath}`);
    console.log(`  Cert: ${certPath}`);
    console.log('\nTo trust: On Mac, double-click cert.pem → Keychain → Always Trust');
    return true;
  } catch {
    return false;
  }
}

if (!tryMkcert() && !tryOpenssl()) {
  console.log('Neither mkcert nor openssl found.');
  console.log('Install mkcert: https://github.com/FiloSottile/mkcert');
  console.log('  brew install mkcert && mkcert -install');
  console.log('Or install openssl and rerun this script.');
  console.log('\nAlternatively, use Cloudflare Tunnel for HTTPS:');
  console.log('  cloudflared tunnel --url http://localhost:4000');
}

console.log(`
Next: Enable HTTPS in server/config.json:
{
  "server": {
    "https": {
      "enabled": true,
      "keyPath": "./certs/key.pem",
      "certPath": "./certs/cert.pem"
    }
  }
}
`);

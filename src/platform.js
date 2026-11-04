'use strict';

/** What differs between Linux and macOS, as plain functions so the tests can cover both on either one. */

/** The desktop User-Agent. Chrome reports this same frozen Intel string on Apple silicon Macs too. */
function desktopUserAgent(chrome, platform = process.platform) {
  const system = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`;
}

/** Ctrl on both, so a remote's keyboard shortcuts keep working, and Cmd on a Mac. */
const commandHeld = (input, platform = process.platform) => !!(input.control || (platform === 'darwin' && input.meta));

/** The program and arguments that announce the phone server on the local network. */
function advertiser(port, platform = process.platform) {
  return platform === 'darwin'
    ? ['/usr/bin/dns-sd', ['-R', 'TVCouchBrowser', '_http._tcp', 'local', String(port)]]
    : ['avahi-publish-service', ['TVCouchBrowser', '_http._tcp', String(port)]];
}

/** The interface named in the output of macOS's `route -n get default`. */
const routeInterface = (output) => /^\s*interface:\s*(\S+)/m.exec(output)?.[1] ?? null;

/** Without an application menu, a Mac has no Cmd+C, Cmd+V or Cmd+Q: those keys go through the menu. */
const MAC_MENU = [
  { label: 'TVCouchBrowser', submenu: [{ role: 'quit', label: 'Quit TVCouchBrowser' }] },
  { role: 'editMenu' },
  { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
  { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }, // no Close: Cmd+W would quit the app
];

module.exports = { desktopUserAgent, commandHeld, advertiser, routeInterface, MAC_MENU };

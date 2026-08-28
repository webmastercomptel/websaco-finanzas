// src/common/dns-setup.ts
//
// Side-effect module: force well-known public DNS resolvers for this process.
// MongoDB Atlas (mongodb+srv://) needs an SRV lookup, and some local / VPN /
// corporate resolvers refuse it (querySrv ECONNREFUSED). The MongoDB driver
// honors dns.setServers() for resolveSrv, so importing this FIRST — before any
// Nest app/context is created — makes Atlas reachable regardless of the host
// resolver. Import it as the very first import in every entrypoint (main.ts,
// seed scripts).
//
// Only `resolveSrv`/`resolve*` are affected: those go through c-ares, which
// reads this list. `dns.lookup()` keeps using the OS resolver, so ordinary
// hostname resolution and the hosts file are untouched.
import * as dns from 'node:dns';

dns.setServers(['8.8.8.8', '1.1.1.1']);

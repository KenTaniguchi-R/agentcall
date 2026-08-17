# Local Windows testing on an Apple-silicon Mac

**Date:** 2026-08-03  
**Status:** Research note, not a product decision.  
**Method:** Exa was used to discover candidate products and documentation. Claims
below were then checked against primary vendor documentation on 2026-08-03.
**Target:** Apple M4 Pro MacBook Pro, 48 GB RAM; testing AgentCall's Node CLI,
installer and Windows listener lifecycle.

---

## TL;DR

There is no local option that replaces a native x64 Windows CI runner. An
Apple-silicon Mac efficiently virtualizes **Windows 11 Arm64**; Windows itself can
emulate ordinary x86 and x64 user-mode applications, but drivers must be Arm64 and
emulation adds another compatibility layer. Microsoft explicitly documents x86/x64
app emulation and the native-driver boundary
([Windows on Arm FAQ](https://learn.microsoft.com/en-us/windows/arm/faq)).

For this project:

1. **Best local experience: Parallels Desktop Pro.** It has the most complete
   Windows-on-Mac integration and the developer edition includes a CLI, snapshots,
   clones, shared folders and guest operations. Exa's current capture of Parallels'
   official US mobile buy page showed **$199.99/year** for Pro; the site renders
   prices dynamically and runs promotions, so confirm the checkout price before
   buying. It is the only option in this list
   that Microsoft calls an authorized solution for Windows 11 Arm on Apple silicon
   ([Microsoft](https://support.microsoft.com/en-us/windows/experience/platform-variants/options-for-using-windows-11-with-mac-computers-with-apple-m1-m2-and-m3-chips),
   [Parallels pricing](https://www.parallels.com/products/desktop/buy/)).
2. **Best value: VMware Fusion Pro plus OpenSSH/WinRM.** Fusion is free for personal
   and commercial use and has snapshots, clones and host-side automation. Its
   Windows Arm integration remains materially weaker: Broadcom says shared folders
   are unsupported, and the Windows Arm tools do not provide guest operations used
   by `vmrun`. Keep a separate clone on the VM's NTFS disk and automate it over the
   network
   ([licensing](https://knowledge.broadcom.com/external/article/368667),
   [Windows Arm limitations](https://knowledge.broadcom.com/external/article/315602),
   [feature matrix](https://knowledge.broadcom.com/external/article/315609)).
3. **Keep GitHub Actions `windows-2025` as the x64 release gate.** Local Arm64 is
   excellent for fast work on paths, ACLs, Scheduled Tasks/services and process
   teardown, but it cannot prove that an x64 package and installer behave correctly
   on an x64 kernel.

The practical choice is therefore **Fusion first if cost matters; Parallels Pro if
the friction of network-based guest automation costs more than roughly $200/year**.
Daytona is useful only when a clean remote Windows machine or debugging outside CI
is needed.

---

## Comparison

| Option | Windows 11 Arm | Automation / headless | Reset and file transfer | Cost and verdict |
|---|---|---|---|---|
| **Parallels Desktop Pro** | Supported; Microsoft-authorized solution | `prlctl` CLI in Pro; VM lifecycle, clone, snapshot and guest execution are scriptable | Mature snapshots/clones and Parallels Tools shared folders | **$199.99/year in the official US mobile-page capture; verify checkout because pricing is dynamic.** Best daily developer loop. Standard is cheaper but omits the CLI and caps VMs at 4 vCPU/8 GB. |
| **VMware Fusion Pro 26H1** | Supported; Arm guests only on Apple silicon | `vmcli`, `vmrun` and REST API control VM lifecycle; no Windows Arm `vmrun` guest operations | Snapshots/clones work. Windows Arm shared folders do not, so use Git/SSH/SMB | **Free**, including commercial use. Best value and sufficient for AgentCall with a little setup. |
| **UTM** | Supported through QEMU; official Windows 11 Arm guide | `utmctl`, AppleScript and Shortcuts cover basic lifecycle; headless mode exists but the UTM app must remain open | Windows SPICE shared folders work; automation surface is explicitly incomplete | Free/open source (optional paid App Store copy). Good manual fallback, weaker repeatable harness. |
| **VirtualBox 7.2** | Newly supports Windows 11 Arm guests on Apple-silicon hosts | Excellent `VBoxManage`, headless frontend and guest-control model | Snapshots, clones and Arm Guest Additions are available | Free base product and the most interesting new contender, but Oracle labels the Arm host/Windows Arm path **experimental**. Evaluate, do not make it the required harness yet. |
| **Lima 2.x** | Experimental **Windows Server 2025**, not the normal Windows 11 desktop target | Excellent headless `limactl` workflow and command execution | Snapshot commands and Windows guests are both experimental; Windows VirtioFS work is still evolving | Free/open source. Promising for a future disposable server-side test harness, not today's primary workstation VM. |
| **Direct QEMU** | Arm64 virtualization and x64 full-system emulation are possible | Fully scriptable and headless | Qcow2 overlays/snapshots; file sharing must be assembled | Free, but substantially more setup. x64 emulation is slow and still not equivalent to a native x64 host. Use only for a narrow architecture experiment. |
| **Tart / OrbStack / Multipass** | No suitable Windows 11 guest workflow | Strong CLIs for the OSes they support | N/A | Not candidates. Tart documents macOS/Linux guests; OrbStack and Multipass are Linux-focused. |

Primary support for the table:

- Parallels advertises the Pro CLI and developer automation on its
  [edition comparison](https://www.parallels.com/products/desktop/buy/). Its
  [command-line reference](https://download.parallels.com/desktop/v18/docs/en_US/Parallels%20Desktop%20Command-Line%20Reference.pdf)
  documents clone and snapshot operations, while its
  [sharing documentation](https://kb.parallels.com/en/122567) covers bidirectional
  host/guest folders.
- Fusion's current manual lists `vmrun`, `vmcli` and a REST API
  ([Fusion Pro 26H1 manual](https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/fusion-pro/26H1/using-vmware-fusion.html)).
- UTM documents Windows Arm installation and SPICE folder sharing in its
  [Windows guide](https://docs.getutm.app/guides/windows/), and describes the
  incomplete automation surface and `utmctl` in its
  [scripting guide](https://docs.getutm.app/scripting/scripting/). Its
  [headless documentation](https://docs.getutm.app/advanced/headless/) says the
  application must remain open.
- Oracle added Windows 11 Arm guests and Arm Guest Additions in VirtualBox 7.2,
  while retaining the experimental label for Arm hosts
  ([7.2 release notes](https://docs.oracle.com/en/virtualization/virtualbox/7.2/relnotes/relnotes-rn-features.html)).
- Lima lists `windows-2025` under experimental non-Linux templates
  ([templates](https://lima-vm.io/docs/templates/)); Windows guests and snapshot
  commands remain on its
  [experimental-feature list](https://lima-vm.io/docs/releases/experimental/).
- Tart's own quick start states that its supported guests are macOS and Linux
  ([Tart](https://tart.run/quick-start/)). Multipass describes itself as a tool for
  on-demand Ubuntu VMs
  ([Canonical](https://documentation.ubuntu.com/multipass/)).

---

## Why Arm64 is still useful for AgentCall

The relevant Windows behaviors are OS behaviors, not CPU behaviors:

- drive-letter and backslash paths, `%APPDATA%`, `%LOCALAPPDATA%` and long paths;
- NTFS ACL creation and inheritance;
- Scheduled Tasks or Windows service installation, startup and recovery;
- console control events, child-process tracking, Job Objects and teardown;
- firewall prompts, loopback/listener behavior and PowerShell quoting;
- MSI/MSIX/EXE install, upgrade and uninstall flow.

A Windows 11 Arm VM exercises all of these. It can also run an x64 Node build under
Windows' user-mode emulator. It does **not** validate native addons or drivers that
only ship for x64, architecture selection in release metadata, or x64-only installer
bootstrap behavior with complete confidence. Microsoft notes that Windows 11 Arm
emulates x86/x64 applications but never kernel drivers
([emulation details](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation)).

For installer testing, copy the packed artifact into an ordinary directory on the
VM's virtual NTFS disk before running it. Do not run the final test from a shared
folder: Parallels presents host shares through its integration layer, UTM through
SPICE, and Fusion does not support Windows Arm shares. None reproduces a normal local
NTFS install source exactly.

---

## Recommended setup

### Zero-cost default: Fusion

- 6 vCPU, 12 GB RAM and a 100 GB dynamically allocated disk are ample on this
  48 GB host.
- Install Windows 11 Pro Arm, current updates, Node's Arm64 and x64 distributions,
  Git, PowerShell 7 and Windows OpenSSH Server.
- Clone AgentCall **inside Windows**. Use SSH, WinRM or Git to move source and
  artifacts; do not share the active macOS checkout.
- Create a clean snapshot after tools and updates, then a test snapshot after the
  repository bootstrap. Broadcom provides a built-in "Get Windows from Microsoft"
  flow for the correct Arm64 image
  ([setup](https://knowledge.broadcom.com/external/article/375069)).
- Run guest commands over SSH/PowerShell remoting. Use Fusion's CLI only for
  start/stop/snapshot/clone orchestration, since its Windows Arm guest agent does not
  expose `vmrun` guest operations.

### Paid convenience: Parallels Pro

Choose Pro when one-command reset-and-test from macOS is worth the subscription. It
allows more than Standard's 4 vCPU/8 GB cap and includes the command-line interface.
Keep shared-profile mirroring disabled for correctness and safety; share only an
explicit artifact directory when convenience matters. Parallels itself notes that
shared folders are integration paths rather than ordinary local files and documents
installer/application edge cases
([shared-profile behavior](https://kb.parallels.com/en/6912)).

### Experimental watchlist: VirtualBox and Lima

VirtualBox 7.2 is worth a short spike because `VBoxManage`, headless operation,
snapshots and Guest Additions could deliver Parallels-like automation without a
subscription. The experimental support label makes it a secondary environment until
it survives repeated Windows updates, snapshot restores, networking and unattended
installer runs.

Lima is even more automation-oriented, but its current official Windows target is
Server 2025 and the Windows guest work is explicitly experimental. Revisit it when a
stable Windows 11 template, reliable VirtioFS/guest agent and non-experimental
snapshots land.

---

## Test boundary

Use three layers rather than asking one environment to prove everything:

1. **Fast local:** Windows 11 Arm VM on Fusion or Parallels; run unit/integration
   tests plus real Scheduled Task/service, ACL, installer and process-tree tests.
2. **Required release gate:** GitHub-hosted native x64 Windows runner; pack the npm
   artifact and run install/start/call/stop/uninstall smoke tests there.
3. **On-demand diagnosis:** Daytona Windows VM only when CI fails opaquely or a
   persistent clean remote desktop is needed; verify the provisioned architecture
   rather than assuming it is x64.

Docker on this Mac is not a fourth Windows layer. Containers share the host kernel;
macOS Docker can test the Linux package but cannot supply Windows kernel semantics,
the Service Control Manager, Scheduled Tasks or NTFS ACL behavior.

Every local VM still needs a valid Windows license. UTM states this explicitly in its
[Windows installation guide](https://docs.getutm.app/guides/windows/), and Microsoft's
Parallels guidance requires a Windows 11 Pro license before using Enterprise. The VM
product price and the Windows license are separate.

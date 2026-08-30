import type { MachineFormat, MachineKind, MachineProvider } from "./types";

const EMBROIDERY_SOFTWARE = ["Wilcom", "Hatch", "Embrilliance", "Ink/Stitch"];

/**
 * Machines a decoration shop is likely to own, with the file formats and
 * connection methods each accepts. Formats are listed preferred-first.
 * Setup text is written for the shop; developerNotes for whoever wires a
 * direct integration and needs to ask the shop the right questions.
 */
export const MACHINE_PROVIDERS: MachineProvider[] = [
  // ---- Embroidery -------------------------------------------------------
  {
    brand: "Tajima",
    connections: ["usb-stick", "lan", "network-folder", "usb-cable"],
    developerNotes:
      "Ask for the exact model number and whether it has the LAN option board. TMBP/TFMX/SAI machines with LAN read designs from a shared network folder through Tajima Network Manager or DG16 'Machine Connect'; older TMEX/TEJT heads only take USB sticks or floppy emulators and list 8.3 filenames, so keep DST names short and uppercase. Confirm whether the shop wants DST (universal, no colour info) or TBF (keeps needle assignments; not produced here).",
    formats: ["dst", "exp"],
    hoops: [
      { heightMm: 120, name: "Cap frame", widthMm: 360 },
      { heightMm: 300, name: "Tubular 300", widthMm: 300 },
      { heightMm: 450, name: "Border frame", widthMm: 500 },
    ],
    id: "tajima",
    kind: "embroidery",
    maxNeedles: 15,
    models: ["TMBP-SC", "TMBP-S", "TFMX-IIC", "TMEZ-SC", "SAI", "TMEX-C"],
    name: "Tajima commercial heads",
    setup:
      "Save the DST to a USB stick and load it from the machine panel, or drop it into the Tajima network folder if the machine has LAN and the shop runs Tajima Network Manager. Assign needles to colours on the panel before sewing.",
    shortFilenames: true,
    software: ["Tajima DG16", "Pulse", "Wilcom"],
  },
  {
    brand: "Brother",
    connections: ["usb-stick", "wifi", "lan", "usb-cable"],
    developerNotes:
      "Ask which PR model: PR680W and PR1055X have Wi-Fi and pick designs up from a watched 'Link' folder via PE-Design 11 or the Brother Artspira app; the older PR-600/650/655 series read USB sticks (and CF cards on the 600) only. All accept PES natively — send PES rather than DST so the machine shows thread colours. Entrepreneur Pro X (PR1055X) supports the Brother 'Link' network sewing function; confirm whether the shop has it enabled and what folder path it watches.",
    formats: ["pes", "dst", "exp", "jef"],
    hoops: [
      { heightMm: 100, name: "100×100", widthMm: 100 },
      { heightMm: 180, name: "130×180", widthMm: 130 },
      { heightMm: 300, name: "200×300", widthMm: 200 },
      { heightMm: 360, name: "360×200", widthMm: 360 },
    ],
    id: "brother-pr",
    kind: "embroidery",
    maxNeedles: 10,
    models: [
      "PR680W",
      "PR1055X",
      "PR1050X",
      "PR670E",
      "PR655",
      "Entrepreneur Pro X",
      "Entrepreneur One PR1X",
    ],
    name: "Brother PR-series / Entrepreneur",
    setup:
      "Export a PES (the machine reads DST and JEF too, but PES keeps the thread colours) and copy it to a USB stick, or send it from PE-Design / Artspira over Wi-Fi on the W/X models. Load it from the machine's touch screen, check the hoop it picked, and confirm colour order.",
    software: ["PE-Design 11", "Artspira", "Wilcom", "Hatch"],
  },
  {
    brand: "Barudan",
    connections: ["usb-stick", "lan", "network-folder"],
    developerNotes:
      "Ask for the model and the controller generation (BEXT, BEXY, BEDSH…). Modern Barudan heads with the BEXY/Automat controller accept DST and Barudan's own U01/FDR-III formats and can pull from a LAN share via Barudan's LEM/Automat networking; older controllers are USB-stick-only with 8-character names. DST is safe everywhere.",
    formats: ["dst", "exp"],
    hoops: [
      { heightMm: 100, name: "Cap frame", widthMm: 300 },
      { heightMm: 400, name: "Tubular 400", widthMm: 400 },
    ],
    id: "barudan",
    kind: "embroidery",
    maxNeedles: 15,
    models: ["BEXT-S1501CBII", "BEXY-S1501CII", "BEKS-S1515C", "BEDSH-YS"],
    name: "Barudan",
    setup:
      "Copy the DST to a USB stick with a short uppercase filename and load it from the Automat panel, or place it in the machine's shared network folder if the shop has LAN networking set up.",
    shortFilenames: true,
    software: ["Wilcom", "Pulse", "Tajima DG16"],
  },
  {
    brand: "Ricoma",
    connections: ["usb-stick", "usb-cable", "wifi", "lan"],
    developerNotes:
      "Ask whether it is the EM (single-head 10/15 needle), MT (multi-head) or CHT (cap) line and which panel it has. Ricoma reads DST natively; Chroma software (bundled) exports DST. Newer panels support a USB-cable link and the Ricoma Wi-Fi module, but most shops just use a stick. There is no public API — the practical integration is a watched USB or network folder.",
    formats: ["dst", "exp"],
    hoops: [
      { heightMm: 100, name: "Cap frame", widthMm: 360 },
      { heightMm: 300, name: "Tubular 300", widthMm: 300 },
      { heightMm: 560, name: "Max frame", widthMm: 360 },
    ],
    id: "ricoma",
    kind: "embroidery",
    maxNeedles: 20,
    models: [
      "EM-1010",
      "EM-1515",
      "MT-1501",
      "MT-2002",
      "CHT2-1501",
      "TC-1501",
    ],
    name: "Ricoma",
    setup:
      "Export a DST, copy it to a USB stick and load it from the touch panel. Set needle colours on the panel, then hoop and trace before running.",
    software: ["Chroma", "Wilcom", "Hatch"],
  },
  {
    brand: "Melco",
    connections: ["usb-cable", "lan", "cloud"],
    developerNotes:
      "Melco machines are PC-driven: the Amaya and EMT16 series run from Melco OS / DesignShop on a connected Windows PC over USB or Ethernet, and the newer Bravo/EMT16X can use Melco's cloud-connected 'Melco OS v12'. Ask whether their PC has a folder DesignShop watches, and whether they want EXP (native, keeps colour sequence in the .inf sidecar) or OFM. EXP is what this package writes; the .inf colour sidecar is not produced.",
    formats: ["exp", "dst"],
    hoops: [
      { heightMm: 120, name: "Cap frame", widthMm: 270 },
      { heightMm: 300, name: "Tubular 300", widthMm: 300 },
      { heightMm: 400, name: "Large square", widthMm: 400 },
    ],
    id: "melco",
    kind: "embroidery",
    maxNeedles: 16,
    models: [
      "EMT16X",
      "EMT16 Plus",
      "EMT16",
      "Amaya XT",
      "Amaya XTS",
      "Bravo X",
    ],
    name: "Melco EMT16 / Amaya / Bravo",
    setup:
      "Melco heads run from Melco OS on the shop PC. Open the EXP (or DST) in Melco OS, set the colour sequence and start the machine from the PC — there is no USB stick slot on the head.",
    software: ["Melco OS", "DesignShop", "Wilcom"],
  },
  {
    brand: "SWF",
    connections: ["usb-stick", "lan", "network-folder"],
    developerNotes:
      "Ask for the model (E-series single head, KE/MA multi-head) and controller firmware. SWF reads DST and its own SST; recent controllers with the LAN option pull from an SWF network folder via SWF's 'Network' menu. USB stick is universal.",
    formats: ["dst", "exp"],
    hoops: [
      { heightMm: 100, name: "Cap frame", widthMm: 300 },
      { heightMm: 400, name: "Tubular 400", widthMm: 400 },
    ],
    id: "swf",
    kind: "embroidery",
    maxNeedles: 15,
    models: ["E-U1501C", "KE-UH1506", "MAS-12", "ES-T1201C"],
    name: "SWF",
    setup:
      "Export a DST to a USB stick and load it on the SWF panel, or use the network folder if the machine has the LAN option. Assign needles on the panel before sewing.",
    software: ["Wilcom", "Pulse"],
  },
  {
    brand: "Happy",
    connections: ["usb-stick", "lan", "network-folder", "usb-cable"],
    developerNotes:
      "Ask whether it is the HCD3 (12/15 needle single head) or HCH/HCS series and whether the shop bought the LAN networking option — Happy Link / HappyNet software can push designs over Ethernet. DST and TAP (Happy's own) are native; DST is fine.",
    formats: ["dst", "exp"],
    hoops: [
      { heightMm: 70, name: "Cap frame", widthMm: 360 },
      { heightMm: 300, name: "Tubular 300", widthMm: 300 },
      { heightMm: 450, name: "Border frame", widthMm: 400 },
    ],
    id: "happy",
    kind: "embroidery",
    maxNeedles: 15,
    models: ["HCD3-1501", "HCH-701", "HCS3-1201", "HCR3-1504"],
    name: "Happy Japan",
    setup:
      "Copy the DST to a USB stick and load from the panel, or send it with Happy Link over the network if the shop has the LAN option installed.",
    software: ["Wilcom", "Happy Link"],
  },
  {
    brand: "ZSK",
    connections: ["usb-stick", "lan", "network-folder"],
    developerNotes:
      "ZSK's T8 controller reads DST and ZSK's own Z formats and networks natively through ZSK's 'EPCwin'/'T8-Net'. Ask for the model (Sprint 6/7 single head, Racer, Challenger) and whether it has a network drop; DST over USB stick always works.",
    formats: ["dst", "exp"],
    hoops: [
      { heightMm: 110, name: "Cap frame", widthMm: 360 },
      { heightMm: 330, name: "Tubular 330", widthMm: 330 },
    ],
    id: "zsk",
    kind: "embroidery",
    maxNeedles: 18,
    models: ["Sprint 7", "Sprint 6", "Racer 1XL", "Challenger", "JAFA"],
    name: "ZSK",
    setup:
      "Export a DST, load it from a USB stick on the T8 panel or through T8-Net if the machine is on the shop network. Assign needle colours on the panel.",
    software: ["EPCwin", "Wilcom"],
  },
  {
    brand: "Janome",
    connections: ["usb-stick", "usb-cable"],
    developerNotes:
      "The MB-7 and MB-4S read JEF (native) and DST from a USB stick or via the RCS remote panel connected over USB; the MB-7's Windows 'Embroidery Editor' can push designs by cable. Send JEF so the thread colours show. Ask whether they have the RCS unit or run from the PC.",
    formats: ["jef", "dst"],
    hoops: [
      { heightMm: 50, name: "Hoop A 50×50", widthMm: 50 },
      { heightMm: 110, name: "Hoop B 110×110", widthMm: 110 },
      { heightMm: 200, name: "Hoop C 140×200", widthMm: 140 },
      { heightMm: 200, name: "Hoop D 200×200", widthMm: 200 },
    ],
    id: "janome-mb",
    kind: "embroidery",
    maxNeedles: 7,
    models: ["MB-7", "MB-4S", "MB-4N"],
    name: "Janome MB-series",
    setup:
      "Export a JEF and copy it to a USB stick or load it through the RCS panel / Embroidery Editor on the PC. Pick the matching hoop letter on the machine.",
    software: ["Janome Embroidery Editor", "Artistic Digitizer", "Hatch"],
  },
  {
    brand: "Bernina",
    connections: ["usb-cable", "usb-stick"],
    developerNotes:
      "The Bernina E16 / E16 Plus is a rebadged Melco EMT16 and runs entirely from Bernina Embroidery Software (Wilcom-based) or Melco OS on a connected PC, so treat it like Melco: EXP or DST handed to the operator's PC. Ask whether they run Melco OS or Bernina Embroidery Software v9.",
    formats: ["exp", "dst", "pes"],
    hoops: [
      { heightMm: 300, name: "Tubular 300", widthMm: 300 },
      { heightMm: 120, name: "Cap frame", widthMm: 270 },
    ],
    id: "bernina-e16",
    kind: "embroidery",
    maxNeedles: 16,
    models: ["E16", "E16 Plus"],
    name: "Bernina E16",
    setup:
      "Open the EXP (or DST) in the Bernina/Melco software on the shop PC that drives the machine, set the colours and start from there.",
    software: ["Bernina Embroidery Software", "Melco OS"],
  },
  {
    brand: "Baby Lock",
    connections: ["usb-stick", "wifi", "usb-cable"],
    developerNotes:
      "Baby Lock multi-needles (Array, Valiant, Venture, Alliance) are Brother PR machines under another badge — same PES-first workflow and the same Wi-Fi 'Link' folder feature on the Array/Valiant/Venture. Ask which model; anything older than the Alliance is USB-stick only.",
    formats: ["pes", "dst", "jef"],
    hoops: [
      { heightMm: 100, name: "100×100", widthMm: 100 },
      { heightMm: 180, name: "130×180", widthMm: 130 },
      { heightMm: 300, name: "200×300", widthMm: 200 },
    ],
    id: "babylock",
    kind: "embroidery",
    maxNeedles: 10,
    models: ["Array", "Valiant", "Venture", "Alliance", "Capella"],
    name: "Baby Lock multi-needle",
    setup:
      "Export a PES, copy it to a USB stick (or send it over Wi-Fi from Palette / Baby Lock IQ Designer on the newer models) and load it from the touch screen.",
    software: ["Palette 11", "IQ Designer", "Hatch"],
  },
  {
    brand: "Generic",
    connections: ["usb-stick"],
    developerNotes:
      "Fallback for any embroidery head not listed. Every commercial machine made in the last 25 years reads Tajima DST from a USB stick, so start there; ask the shop for make/model/panel type and whether they need colour information (then PES/JEF/EXP+INF) or 8.3 filenames.",
    formats: ["dst", "exp", "pes", "jef"],
    id: "generic-embroidery",
    kind: "embroidery",
    models: [],
    name: "Any embroidery machine",
    setup:
      "Export a DST, copy it to a USB stick, load it from the machine's panel and assign the needle colours by hand.",
    shortFilenames: true,
    software: EMBROIDERY_SOFTWARE,
  },
  // ---- Direct-to-garment -------------------------------------------------
  {
    brand: "Brother",
    connections: ["usb-cable", "lan", "usb-stick"],
    developerNotes:
      "GTX / GTXpro / GTXpro B print through Brother's 'GTX Graphics Lab' or a RIP (Kothari / CADlink) which produces an .arx / .arxp print file; the machine itself takes that file from USB stick, or the driver over USB/Ethernet. Ask which RIP they run and whether the driver is installed on a networked PC — the practical integration is dropping a transparent PNG (300 dpi) into the RIP's hot folder.",
    formats: ["png", "tiff", "pdf"],
    id: "brother-gtx",
    kind: "dtg",
    models: ["GTX", "GTXpro", "GTXpro B", "GTX600"],
    name: "Brother GTX series",
    setup:
      "Give the operator a transparent PNG at 300 dpi sized to the print area. They open it in GTX Graphics Lab or the RIP, choose the platen and ink settings, and send it to the printer over USB or the network.",
    software: [
      "GTX Graphics Lab",
      "Kothari Print Pro",
      "CADlink Digital Factory",
    ],
  },
  {
    brand: "Epson",
    connections: ["usb-cable", "lan", "wifi"],
    developerNotes:
      "SureColor F2100 / F2270 / F3070 print from Epson Garment Creator 2 (free) or a RIP such as Kothari / CADlink over USB or Ethernet. Garment Creator has a hot-folder mode on Windows. Ask whether they use Garment Creator or a RIP, what platen sizes they have, and whether the F2270's DTF film mode is used — that changes the artwork (mirror + white underbase).",
    formats: ["png", "tiff", "pdf"],
    id: "epson-surecolor-f2",
    kind: "dtg",
    models: [
      "SureColor F2100",
      "SureColor F2270",
      "SureColor F3070",
      "SureColor F3030",
    ],
    name: "Epson SureColor F2100 / F2270 / F3070",
    setup:
      "Provide a transparent PNG at 300 dpi. The operator loads it in Epson Garment Creator 2 (or their RIP), picks the platen and white-underbase setting, and prints over USB or the shop network.",
    software: [
      "Epson Garment Creator 2",
      "Kothari Print Pro",
      "CADlink Digital Factory",
    ],
  },
  {
    brand: "Kornit",
    connections: ["lan", "cloud"],
    developerNotes:
      "Kornit Breeze / Atlas / Avalanche run from KornitX / QuickP Pro on a dedicated workstation, and KornitX offers a real order API (KornitX Global Fulfilment Network). Ask whether the shop is on KornitX and can share an API key — that is the only DTG platform here with a proper integration surface; otherwise artwork goes to the QuickP hot folder as PNG/TIFF.",
    formats: ["png", "tiff", "pdf"],
    id: "kornit",
    kind: "dtg",
    models: [
      "Breeze",
      "Atlas MAX",
      "Atlas MAX Poly",
      "Avalanche HD6",
      "Storm HD6",
    ],
    name: "Kornit",
    setup:
      "Provide a transparent PNG or TIFF. The operator loads it into QuickP / KornitX, sets the substrate and platen, and prints from the workstation.",
    software: ["KornitX", "QuickP Pro"],
  },
  {
    brand: "Ricoh",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "Ricoh Ri 1000 / Ri 2000 (and the Anajet-derived Ri 100) print through ColorGATE Productionserver (bundled) or Kothari over Ethernet/USB. Ask which RIP and whether it has a hot folder; the Ri 2000 also has an on-printer job queue that accepts .rpf files from the RIP.",
    formats: ["png", "tiff", "pdf"],
    id: "ricoh-ri",
    kind: "dtg",
    models: ["Ri 1000", "Ri 1000X", "Ri 2000", "Ri 100"],
    name: "Ricoh Ri series",
    setup:
      "Provide a transparent 300 dpi PNG. The operator opens it in ColorGATE or Kothari, picks the platen and white-ink settings, and prints to the Ri over the network.",
    software: ["ColorGATE Productionserver", "Kothari Print Pro"],
  },
  {
    brand: "Polyprint",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "TexJet echo2 / shortee2 / NG run from CADlink Digital Factory (Polyprint edition) on a Windows PC over USB or Ethernet. Ask for the CADlink hot-folder path and their default queue; PNG with transparency is the normal input.",
    formats: ["png", "tiff", "pdf"],
    id: "polyprint-texjet",
    kind: "dtg",
    models: ["TexJet echo2", "TexJet shortee2", "TexJet NG"],
    name: "Polyprint TexJet",
    setup:
      "Provide a transparent PNG. The operator drops it into CADlink Digital Factory, picks the queue for the shirt colour, and prints.",
    software: ["CADlink Digital Factory"],
  },
  // ---- Direct-to-film ----------------------------------------------------
  {
    brand: "Generic",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "Most DTF printers are converted Epson L1800 / XP-15000 / I3200-head roll units driven by a RIP (CADlink Digital Factory DTF edition, AcroRIP, FlexiPRINT, PrintExp). The RIP handles mirroring, white underbase and the powder step. Ask which RIP they run, its hot-folder path, roll width (30cm / 60cm) and whether they gang jobs onto one roll — gang sheets change the export (one PNG per job vs. one sheet).",
    formats: ["png", "tiff", "pdf"],
    id: "generic-dtf",
    kind: "dtf",
    models: [
      "Epson L1800 conversion",
      "XP-15000 conversion",
      "I3200 roll printer",
      "A3 / 30cm roll",
      "60cm roll",
    ],
    name: "DTF printer (Epson-based)",
    setup:
      "Provide a transparent PNG at 300 dpi at the finished print size — do NOT mirror it; the RIP mirrors and adds the white layer. The operator loads it in the RIP, prints to film, powders, cures and presses.",
    software: [
      "CADlink Digital Factory DTF",
      "AcroRIP",
      "FlexiPRINT DTF",
      "PrintExp",
    ],
  },
  {
    brand: "DTG/DTF Prestige",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "Prestige A4 / A3+ / R2 / XL2 (AllAmerican / DTG Pro) ship with CADlink Digital Factory DTF edition. Same integration surface as any DTF unit: a PNG into the RIP hot folder. Ask for the model (sheet vs roll), the RIP version and whether they use Prestige's 'Mini Shaker' inline powdering — inline units want jobs queued in order.",
    formats: ["png", "tiff", "pdf"],
    id: "prestige-dtf",
    kind: "dtf",
    models: [
      "Prestige A4",
      "Prestige A3+",
      "Prestige R2",
      "Prestige XL2",
      "Prestige L2",
    ],
    name: "Prestige DTF",
    setup:
      "Provide a transparent 300 dpi PNG at finished size. The operator loads it in CADlink DTF, prints to film, powders and cures, then heat presses.",
    software: ["CADlink Digital Factory DTF"],
  },
  // ---- Sublimation -------------------------------------------------------
  {
    brand: "Epson",
    connections: ["wifi", "usb-cable", "lan"],
    developerNotes:
      "SureColor F170 (desktop), F570 (24-inch) and F6370 (44-inch) are standard printer drivers — they print anything from the Epson driver, Epson Edge Print, or a RIP. Ask whether they print from the driver (then PDF/PNG mirrored is all you need) or from Edge Print / Wasatch with a hot folder; also ask about ICC profile and paper (they matter for colour, not for file format).",
    formats: ["pdf", "png", "tiff"],
    id: "epson-surecolor-f-sublimation",
    kind: "sublimation",
    models: [
      "SureColor F170",
      "SureColor F570",
      "SureColor F6370",
      "SureColor F9470",
    ],
    name: "Epson SureColor F sublimation",
    setup:
      "Provide a PDF or PNG at print size. The operator prints it mirrored from the Epson driver or Edge Print onto sublimation paper, then presses the blank.",
    software: ["Epson Edge Print", "Wasatch SoftRIP", "Adobe / Affinity"],
  },
  {
    brand: "Sawgrass",
    connections: ["wifi", "usb-cable", "lan"],
    developerNotes:
      "SG500 / SG1000 print only through Sawgrass 'CreativeStudio' or the 'Sawgrass Print Manager' (SPM) which does colour management and mirroring; SPM installs as a virtual printer on Windows/macOS and accepts prints from any app. Ask whether SPM is installed on a PC we can reach — if so, printing a PDF to the SPM printer is the integration. There is no public API.",
    formats: ["pdf", "png", "tiff"],
    id: "sawgrass",
    kind: "sublimation",
    models: ["SG500", "SG1000", "SG3110DN", "Virtuoso VJ628"],
    name: "Sawgrass Virtuoso SG500 / SG1000",
    setup:
      "Provide a PDF or PNG at print size. The operator prints through Sawgrass Print Manager, which mirrors and colour-manages it, then presses the blank.",
    software: ["Sawgrass Print Manager", "CreativeStudio"],
  },
  // ---- Vinyl / heat-transfer cutters -------------------------------------
  {
    brand: "Cricut",
    connections: ["usb-cable", "wifi"],
    developerNotes:
      "Cricut Maker / Explore / Joy cut only from Cricut Design Space (desktop or app), which imports SVG/PNG/JPG/DXF. There is no API and no hot folder; the operator has to upload the file themselves. Ask which machine (Maker 3 handles Smart Materials without a mat, 12-inch max width) and give them an SVG with cut paths and a 'mirror for HTV' reminder.",
    formats: ["svg", "png", "dxf"],
    id: "cricut",
    kind: "vinyl",
    models: [
      "Maker 3",
      "Maker",
      "Explore 3",
      "Explore Air 2",
      "Joy Xtra",
      "Venture",
    ],
    name: "Cricut",
    setup:
      "Provide an SVG (cut lines as paths). The operator uploads it to Design Space, mirrors it for heat-transfer vinyl, cuts, weeds and presses.",
    software: ["Cricut Design Space"],
  },
  {
    brand: "Silhouette",
    connections: ["usb-cable", "wifi"],
    developerNotes:
      "Silhouette Cameo 4/5 and Portrait cut from Silhouette Studio (free edition imports PNG/JPG/DXF; SVG needs Designer Edition or higher). Studio has no hot folder but Business Edition adds a 'Send' queue. Ask which Studio edition they have — that decides SVG vs DXF — and machine width (12 / 15 / 24 inch).",
    formats: ["svg", "dxf", "png"],
    id: "silhouette",
    kind: "vinyl",
    models: ["Cameo 5", "Cameo 4", "Cameo 4 Plus", "Cameo 4 Pro", "Portrait 4"],
    name: "Silhouette Cameo / Portrait",
    setup:
      "Provide an SVG (Designer Edition or above) or DXF. The operator opens it in Silhouette Studio, mirrors it for HTV, sets the blade and cuts.",
    software: ["Silhouette Studio"],
  },
  {
    brand: "Roland",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "Roland GS-24 / GX-24 / GR series cut from CutStudio (free) or from Illustrator/CorelDRAW plug-ins and RIPs like VersaWorks / FlexiSIGN, over USB or Ethernet on the GR. Ask which software drives the cutter and whether it has a hot folder (FlexiSIGN Production Manager does). EPS with 0.25 pt cut lines is the traditional interchange; SVG works in newer CutStudio.",
    formats: ["eps", "svg", "dxf", "pdf"],
    id: "roland-cutter",
    kind: "vinyl",
    models: ["GS-24", "GX-24", "GR-540", "GR-640", "CAMM-1 GS2-24"],
    name: "Roland CAMM-1 cutters",
    setup:
      "Provide an EPS or SVG with outlines as paths. The operator loads it in CutStudio / their RIP, mirrors for HTV, sets force and speed for the material and cuts.",
    software: ["Roland CutStudio", "VersaWorks", "FlexiSIGN"],
  },
  {
    brand: "Graphtec",
    connections: ["usb-cable", "lan", "wifi"],
    developerNotes:
      "Graphtec CE7000 / FC9000 cut from Graphtec Pro Studio, Cutting Master 5 (Illustrator/CorelDRAW plug-in) or FlexiSIGN, via USB or Ethernet (CE7000 has both). Cutting Master can watch a folder. Ask width (40 / 60 / 130 cm) and whether they register ARMS marks for print-and-cut — that requires the registration marks to be in the file.",
    formats: ["eps", "svg", "dxf", "pdf"],
    id: "graphtec",
    kind: "vinyl",
    models: ["CE7000-40", "CE7000-60", "CE7000-130", "CE Lite-50", "FC9000"],
    name: "Graphtec CE7000 / FC9000",
    setup:
      "Provide an EPS or SVG with cut paths (add registration marks for print-and-cut). The operator sends it from Cutting Master / Graphtec Pro Studio, mirrored for HTV.",
    software: ["Graphtec Pro Studio", "Cutting Master 5", "FlexiSIGN"],
  },
  // ---- Screen printing --------------------------------------------------
  {
    brand: "Generic",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "Screen printing has no machine file: the artwork is separated into one film positive per colour and printed on an inkjet (Epson SureColor P-series with AccuRIP / Film Maker) or a CTS unit (M&R i-Image, Exile Spyder). Ask how they image screens (film vs CTS), their RIP (AccuRIP, Wasatch, i-Image software), the max screen size and mesh — the export is a PDF/EPS with registration marks and one page per colour.",
    formats: ["pdf", "eps", "png", "tiff"],
    id: "generic-screen",
    kind: "screen",
    models: [
      "Manual press (film positives)",
      "Automatic press (film positives)",
      "Computer-to-screen (M&R i-Image, Exile Spyder)",
    ],
    name: "Screen printing (film positives / CTS)",
    setup:
      "Provide a PDF or EPS with each ink colour on its own page as solid black, with registration marks. The operator prints films (or images screens directly with CTS), exposes, and prints.",
    software: [
      "AccuRIP",
      "Wasatch SoftRIP",
      "Adobe Illustrator",
      "i-Image STE",
    ],
  },
  // ---- Laser ------------------------------------------------------------
  {
    brand: "Glowforge",
    connections: ["wifi", "cloud"],
    developerNotes:
      "Glowforge runs entirely through the Glowforge web app (cloud). It imports SVG, PDF, PNG and JPG; there is no local driver, no API and no hot folder. The operator uploads the file. Ask which model (Basic/Plus/Pro/Aura/Spark) — the Pro has a pass-through slot; all are ~19.5 × 11 inch beds.",
    formats: ["svg", "pdf", "png"],
    id: "glowforge",
    kind: "laser",
    models: [
      "Glowforge Pro",
      "Glowforge Plus",
      "Glowforge Basic",
      "Aura",
      "Spark",
    ],
    name: "Glowforge",
    setup:
      "Provide an SVG (cut paths as strokes, engrave areas as fills) or a PNG for engraving. The operator uploads it to the Glowforge app, picks the material and runs the job.",
    software: ["Glowforge App"],
  },
  {
    brand: "xTool",
    connections: ["usb-cable", "wifi", "cloud"],
    developerNotes:
      "xTool D1 / P2 / S1 / M1 run from xTool Creative Space (XCS, desktop) or LightBurn, over USB or Wi-Fi. XCS imports SVG/PNG/JPG/DXF; LightBurn adds AI/PDF. No public API, but LightBurn can be driven via its own file queue. Ask which software they use and the bed size / rotary attachments.",
    formats: ["svg", "png", "dxf", "pdf"],
    id: "xtool",
    kind: "laser",
    models: ["P2", "S1", "D1 Pro", "M1", "F1"],
    name: "xTool",
    setup:
      "Provide an SVG or PNG. The operator opens it in xTool Creative Space or LightBurn, sets the material power/speed and sends it to the laser.",
    software: ["xTool Creative Space", "LightBurn"],
  },
  {
    brand: "Epilog",
    connections: ["usb-cable", "lan", "wifi"],
    developerNotes:
      "Epilog Fusion / Helix / Zing print through the Epilog print driver (Windows) from any application, or via the Epilog Dashboard / Job Manager over Ethernet. There is no hot folder in the driver but the Job Manager accepts saved print files. Ask which software they design in (CorelDRAW is common) and the bed size; PDF or SVG with hairline vector strokes is the safe hand-off.",
    formats: ["pdf", "svg", "png", "dxf"],
    id: "epilog",
    kind: "laser",
    models: [
      "Fusion Pro 32",
      "Fusion Pro 48",
      "Fusion Edge",
      "Helix",
      "Zing 24",
      "Mini 24",
    ],
    name: "Epilog",
    setup:
      "Provide a PDF or SVG (hairline strokes for cutting, fills for engraving). The operator opens it in CorelDRAW / Illustrator, prints through the Epilog driver or Dashboard, and runs the job.",
    software: [
      "Epilog Dashboard",
      "Epilog Job Manager",
      "CorelDRAW",
      "LightBurn",
    ],
  },
  // ---- Labels -----------------------------------------------------------
  {
    brand: "Zebra",
    connections: ["usb-cable", "lan", "wifi"],
    developerNotes:
      "Every Zebra ZD/ZT printer accepts raw ZPL II on TCP port 9100 (and over USB via the raw print queue); the ZD-series also speak EPL for legacy jobs. This is the one machine class with a genuine direct integration: open a socket to the printer's IP on port 9100 and write ZPL. Ask for the printer's IP / hostname, the label size (4×6 shipping, 2.25×1.25 barcode…) and DPI (203 or 300) — ZPL coordinates are in dots.",
    formats: ["zpl", "epl", "pdf", "png"],
    id: "zebra",
    kind: "label",
    models: ["ZD421", "ZD621", "ZD220", "ZT411", "ZT231", "GX430t"],
    name: "Zebra ZD / ZT",
    setup:
      "Send ZPL straight to the printer: over the network on port 9100, or via the Zebra driver from a PC. Shipping labels from EasyPost/Stripe arrive as ZPL or PDF — pick ZPL for Zebra.",
    software: ["Zebra Setup Utilities", "ZebraDesigner", "Browser Print"],
  },
  {
    brand: "Rollo",
    connections: ["usb-cable", "wifi"],
    developerNotes:
      "The Rollo USB model prints only through the Rollo driver (PDF/PNG); the Rollo Wireless prints via the Rollo app / AirPrint and also accepts raw ZPL and EPL on port 9100 like a Zebra. Ask which model: Wireless gives a real socket integration, USB means the operator prints a PDF.",
    formats: ["zpl", "epl", "pdf", "png"],
    id: "rollo",
    kind: "label",
    models: ["Rollo Wireless", "Rollo USB"],
    name: "Rollo",
    setup:
      "Rollo Wireless: send ZPL over the network on port 9100 or print the label PDF from the Rollo app. Rollo USB: print the 4×6 PDF through the Rollo driver.",
    software: ["Rollo app", "Rollo driver"],
  },
  {
    brand: "Dymo",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "LabelWriter 450/550/5XL print through the DYMO Connect driver or the DYMO Connect Web Service (a local HTTP service the DYMO JavaScript SDK talks to). They do not speak ZPL. Ask whether DYMO Connect is installed on a PC we can reach; the export is a PDF/PNG at label size (4×6 for the 4XL/5XL, 2⅛×4 for shipping labels on the 450).",
    formats: ["pdf", "png"],
    id: "dymo",
    kind: "label",
    models: [
      "LabelWriter 5XL",
      "LabelWriter 550 Turbo",
      "LabelWriter 4XL",
      "LabelWriter 450",
    ],
    name: "Dymo LabelWriter",
    setup:
      "Print the label PDF through DYMO Connect on the PC the printer is plugged into; pick the label size that matches the roll.",
    software: ["DYMO Connect", "DYMO Connect Web Service"],
  },
  {
    brand: "Brother",
    connections: ["usb-cable", "lan", "wifi"],
    developerNotes:
      "Brother QL-800 / QL-1110NWB print through P-touch Editor or the Brother driver (PDF/PNG). The network models also accept raw ESC/P and Brother's own 'raster' commands on port 9100 (b-PAC SDK on Windows) — not ZPL. Ask which model and whether it is USB-only; PDF at the right label width is the safe hand-off.",
    formats: ["pdf", "png"],
    id: "brother-ql",
    kind: "label",
    models: ["QL-800", "QL-810W", "QL-820NWB", "QL-1110NWB", "QL-1100"],
    name: "Brother QL",
    setup:
      "Print the label PDF through the Brother driver or P-touch Editor, choosing the matching DK roll size.",
    software: ["P-touch Editor", "Brother iPrint&Label"],
  },
  {
    brand: "Generic",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "Fallback for any thermal label printer. Most 4×6 shipping printers (Zebra, Rollo Wireless, Munbyn, iDPRT, TSC) accept ZPL, EPL or TSPL on port 9100; USB-only budget units print PDFs through their driver. Ask for make/model and whether it has a network port; if it does, ZPL is worth trying first.",
    formats: ["zpl", "pdf", "png", "epl", "tspl"],
    id: "generic-label",
    kind: "label",
    models: [],
    name: "Any label printer",
    setup:
      "Send ZPL on port 9100 if the printer is on the network, otherwise print the label PDF through the driver.",
  },
  // ---- Direct-to-film, the rest of the field ---------------------------
  {
    brand: "Epson",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "SureColor F2270 (hybrid DTG/DTF) and G6070 (dedicated DTF) print through Epson Garment Creator 2 or a RIP. Garment Creator watches no folder — the operator opens the file and prints — so the integration is a PNG the operator picks up, or a hot folder if they run CADlink instead. Ask which of the two they use, and whether an F2270 is loaded with DTF or DTG ink today: the same machine cannot do both at once.",
    formats: ["png", "tiff", "pdf"],
    id: "epson-dtf",
    kind: "dtf",
    models: ["SureColor F2270", "SureColor G6070"],
    name: "Epson SureColor DTF",
    setup:
      "Provide a transparent PNG at 300 dpi at the finished size. The operator opens it in Garment Creator 2 (or the RIP), prints to film, powders and cures.",
    software: ["Epson Garment Creator 2", "CADlink Digital Factory DTF"],
  },
  {
    brand: "STS Inks",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "STS resells Mutoh-based roll units (VJ-628D, XPD-724) driven by CADlink or ErgoSoft. Roll width and whether they gang jobs onto one sheet decide whether we export one PNG per job or a laid-up sheet. Ask for the RIP's hot-folder path.",
    formats: ["png", "tiff", "pdf"],
    id: "sts-dtf",
    kind: "dtf",
    models: ["VJ-628D", "XPD-724", "XPD-1362"],
    name: "STS / Mutoh DTF roll printer",
    setup:
      "Provide a transparent PNG at 300 dpi. The operator lays it up in the RIP with the other jobs on the roll, prints, powders and cures.",
    software: ["CADlink Digital Factory DTF", "ErgoSoft"],
  },
  {
    brand: "UniNet",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "iColor 560 / 650 / 800W are toner transfer printers, not inkjet: CMYK plus a white toner pass onto A4/A3 transfer paper through the iColor ProRIP. No powder, no cure — the sheet goes straight to the press. Ask which paper set they run (two-step vs standard), because it decides whether the art is mirrored.",
    formats: ["png", "tiff", "pdf"],
    id: "uninet-icolor",
    kind: "dtf",
    models: ["iColor 560", "iColor 650", "iColor 800W"],
    name: "UniNet iColor transfer printer",
    setup:
      "Provide a transparent PNG at 300 dpi. The operator opens it in iColor ProRIP, picks the paper profile, prints and presses.",
    software: ["iColor ProRIP"],
  },
  {
    brand: "Roland",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "VersaSTUDIO BN-20A prints and cuts from VersaWorks; with DTF film and the transfer set it doubles as a small DTF unit. VersaWorks takes a hot folder. Ask whether the machine is loaded for DTF or for vinyl this week — it is one machine doing two jobs.",
    formats: ["pdf", "png", "svg", "eps"],
    id: "roland-bn20a-dtf",
    kind: "dtf",
    models: ["VersaSTUDIO BN-20A", "VersaSTUDIO BN2-20A"],
    name: "Roland VersaSTUDIO (DTF)",
    setup:
      "Provide a PNG or PDF at the finished size. The operator loads it in VersaWorks, prints to film, powders and cures.",
    software: ["Roland VersaWorks"],
  },
  // ---- Sublimation, the rest of the field ------------------------------
  {
    brand: "Generic",
    connections: ["usb-cable", "wifi", "lan"],
    developerNotes:
      "The small-shop standard is a converted EcoTank (ET-2800 / ET-15000) filled with sublimation ink, printed from the plain Epson driver and mirrored by hand in the print dialogue. No RIP, no hot folder — the file is what the operator opens. Ask the paper size and whether they mirror in the driver or expect the file mirrored.",
    formats: ["pdf", "png", "tiff"],
    id: "generic-sublimation",
    kind: "sublimation",
    models: ["Converted EcoTank ET-2800", "Converted EcoTank ET-15000"],
    name: "Converted desktop sublimation printer",
    setup:
      "Provide a PDF or PNG at the finished size, not mirrored — the operator mirrors it in the print dialogue, prints on transfer paper and presses.",
    software: ["Epson printer driver", "Silhouette Studio"],
  },
  {
    brand: "Mimaki",
    connections: ["lan", "usb-cable"],
    developerNotes:
      "JV100 / JV300 wide-format dye-sub printers drive from RasterLink, which watches hot folders — a real integration surface: drop the file and RasterLink queues it. Ask for the hot-folder path and the roll width.",
    formats: ["pdf", "tiff", "png", "eps"],
    id: "mimaki-jv",
    kind: "sublimation",
    models: ["JV100-160", "JV300-130", "JV300-160"],
    name: "Mimaki JV dye-sublimation",
    setup:
      "Provide a PDF or high-res TIFF at the finished size. The operator lays it up in RasterLink, prints to transfer paper and presses.",
    software: ["Mimaki RasterLink"],
  },
  {
    brand: "Roland",
    connections: ["lan", "usb-cable"],
    developerNotes:
      "Texart RT-640 / XT-640 print from ErgoSoft Roland Edition, which has hot folders. Ask for the hot-folder path, the roll width and whether they nest jobs — nesting changes what we hand over.",
    formats: ["pdf", "tiff", "png", "eps"],
    id: "roland-texart",
    kind: "sublimation",
    models: ["Texart RT-640", "Texart XT-640"],
    name: "Roland Texart dye-sublimation",
    setup:
      "Provide a PDF or TIFF at the finished size. The operator nests it in ErgoSoft, prints to transfer paper and presses.",
    software: ["ErgoSoft Roland Edition"],
  },
  // ---- Cutters, the rest of the field ----------------------------------
  {
    brand: "Brother",
    connections: ["usb-stick", "wifi", "usb-cable"],
    developerNotes:
      "ScanNCut DX cuts from CanvasWorkspace (cloud or desktop) and reads .fcm files off a USB stick; SVG import needs the desktop / Premium version. No API. Ask whether they cut from the stick or from CanvasWorkspace, because it decides whether an SVG on a stick is any use to them.",
    formats: ["svg", "pdf", "png"],
    id: "brother-scanncut",
    kind: "vinyl",
    models: ["ScanNCut DX", "ScanNCut SDX125", "ScanNCut DX2250D"],
    name: "Brother ScanNCut",
    setup:
      "Provide an SVG of the cut lines. The operator imports it into CanvasWorkspace, mirrors it for heat-transfer vinyl, and cuts.",
    software: ["CanvasWorkspace"],
  },
  // ---- Heat presses -----------------------------------------------------
  {
    brand: "Stahls' Hotronix",
    connections: [],
    developerNotes:
      "Nothing to send: a press applies what another machine already made. The Fusion IQ has a network panel and Stahls' own job tracking, but no public API worth building against. Treat a press as a station on the ticket — time, temperature and pressure written down — not as a send target.",
    formats: [],
    id: "hotronix",
    kind: "heat-press",
    models: ["Fusion IQ", "Air Fusion IQ", "Dual Air Fusion IQ", "MAXX Clam"],
    name: "Hotronix heat press",
    setup:
      "No file goes to a press. Set the time, temperature and pressure the transfer calls for, press, and peel hot or cold as the film says.",
  },
  {
    brand: "Geo Knight",
    connections: [],
    developerNotes:
      "DK20S / DK16 / Maxi presses are manual clamshell and swing-away units with a digital controller. No connectivity.",
    formats: [],
    id: "geo-knight",
    kind: "heat-press",
    models: ["DK20S", "DK16", "DK25S", "Maxi Press"],
    name: "Geo Knight heat press",
    setup:
      "No file goes to a press. Dial in time, temperature and pressure, press, and peel as the transfer says.",
  },
  {
    brand: "Hix",
    connections: [],
    developerNotes:
      "Swingman and N-800 series: manual swing-away presses with a digital timer. No connectivity.",
    formats: [],
    id: "hix",
    kind: "heat-press",
    models: ["Swingman 15", "Swingman 20", "N-800"],
    name: "Hix heat press",
    setup:
      "No file goes to a press. Set time, temperature and pressure, press, and peel as the transfer says.",
  },
  {
    brand: "Cricut",
    connections: [],
    developerNotes:
      "EasyPress 2 / 3 are hand presses; the 3 pairs to the Cricut Heat app over Bluetooth for its settings, which is a phone flow rather than something a shop system drives.",
    formats: [],
    id: "cricut-easypress",
    kind: "heat-press",
    models: ["EasyPress 2", "EasyPress 3", "EasyPress Mini"],
    name: "Cricut EasyPress",
    setup:
      "No file goes to a press. Look the setting up in Cricut's heat guide, press, and peel as it says.",
  },
  {
    brand: "Generic",
    connections: [],
    developerNotes:
      "Any clamshell, swing-away, cap or mug press. Recorded so a job can be ticked through it and so its time and temperature live with the order.",
    formats: [],
    id: "generic-press",
    kind: "heat-press",
    models: [
      "Clamshell 15x15",
      "Swing-away 16x20",
      "Cap press",
      "Mug press",
      "Tumbler press",
    ],
    name: "Any heat press",
    setup:
      "No file goes to a press. Set the time, temperature and pressure the transfer calls for, press, and peel hot or cold as the film says.",
  },
  {
    brand: "Generic",
    connections: ["usb-cable", "lan"],
    developerNotes:
      "Fallback for any printer that takes artwork: DTG, DTF, sublimation, wide-format or a cutter not listed here. Ask what RIP or driver they print from, whether it has a hot folder, the maximum print size and which file type their operator prefers — PNG with transparency at 300 dpi is the safe default.",
    formats: ["png", "pdf", "tiff", "svg", "eps"],
    id: "generic-print",
    kind: "dtg",
    models: [],
    name: "Any print / cut machine",
    setup:
      "Provide a transparent PNG at 300 dpi (or a PDF for cutters and sublimation). The operator loads it in their RIP or driver and prints.",
  },
];

export const listMachineProviders = (kind?: MachineKind): MachineProvider[] =>
  kind
    ? MACHINE_PROVIDERS.filter((provider) => provider.kind === kind)
    : [...MACHINE_PROVIDERS];

export const getMachineProvider = (id: string): MachineProvider | undefined =>
  MACHINE_PROVIDERS.find((provider) => provider.id === id);

/**
 * Whether a machine takes a file at all. A heat press does not: it applies
 * what another machine already made, and belongs on the ticket as a station
 * rather than as somewhere to send artwork.
 */
export const machineTakesFiles = (provider: MachineProvider): boolean =>
  provider.formats.length > 0;

export const providersForFormat = (format: MachineFormat): MachineProvider[] =>
  MACHINE_PROVIDERS.filter((provider) => provider.formats.includes(format));

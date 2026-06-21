/**
 * issprom.js — ISSprOM (sprint orienteering map) SVG renderer for TownModel.
 *
 * DOM module: this is the ONLY file in infinite/ allowed to touch the DOM
 * (see CONTRACTS.md §1). Pure vanilla ES module, no dependencies, no build
 * step. Consumes the TownModel schema (CONTRACTS.md §2) and renders it into
 * an existing <svg> element using ISSprOM-style symbology (CONTRACTS.md §4).
 *
 * Clean-room: colours/weights are derived from the written spec in
 * CONTRACTS.md (itself sampled from OCAD ISSprOM exports), not copied from
 * any GPL source.
 *
 * Coordinate convention: planar metres, +x right, +y down — same as SVG, so
 * model coordinates map directly onto the SVG user space after the viewBox
 * is fitted to meta.bbox (CONTRACTS.md §1).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// 1. Colour table (ISSprOM, CONTRACTS.md §4)
// ---------------------------------------------------------------------------

export const COLORS = {
  // open land / "earth" base
  openLand: 'rgb(255,204,54)',
  // building / wall / fence
  black: 'rgb(0,0,0)',
  // forest runnable (used as a light neutral, rarely drawn directly)
  forestRunnable: 'rgb(255,255,255)',
  // paved areas (squares) / roads
  pavedLight: 'rgb(204,204,204)',
  pavedDark: 'rgb(115,115,115)',
  // out-of-bounds / garden / cultivated land ("fields")
  olive: 'rgb(171,193,48)',
  // vegetation
  greenSlow: 'rgb(74,255,23)',
  greenImpassable: 'rgb(0,135,0)',
  // water
  waterFill: 'rgb(74,189,255)',
  waterBank: 'rgb(13,179,255)',
  // light seam between houses within a solid block (house-division lines)
  seam: 'rgb(232,228,220)',
  // course overprint (later phases — kept here for completeness, unused now)
  overprint: 'rgb(255,0,255)',
};

// ---------------------------------------------------------------------------
// 2. Line/point weights, in METRES (converted to px at render time via
//    pxPerMetre = viewBoxPx / sizeM). Tuned by eye against the ISSprOM specs
//    referenced in CONTRACTS.md §4 to look like a real sprint map at the
//    town's scale rather than a wall of black ink.
// ---------------------------------------------------------------------------

export const WEIGHTS = {
  // building/prism outline stroke
  buildingOutline: 0.4,
  // light seam stroke around each house (drawn over the solid block)
  buildingSeam: 1.0,
  // curtain wall stroke (meta.wallThickness overrides this when present)
  wallThickness: 7.6,
  // hedge band width (drawn alongside/instead of a wall ring)
  hedgeWidth: 2.0,
  // fence stroke + tick marks (kept for future fences layer)
  fenceWidth: 0.4,
  fenceTickLength: 1.2,
  fenceTickSpacing: 6,
  // road stroke (meta.roadWidth overrides this when present)
  roadWidth: 8,
  // river stroke (meta.riverWidth overrides this when present)
  riverWidth: 32,
  // river/water bank outline stroke
  waterBankWidth: 0.6,
  // plank/bridge glyph: stroke width + perpendicular tick length
  plankWidth: 1.2,
  plankTickLength: 4,
  // tree dot radius
  treeRadius: 1.8,
  // fountain/well/boulder point radius
  fountainRadius: 1.4,
  wellRadius: 1.4,
  boulderRadius: 1.6,
  // faint district outline (debug aid only)
  districtOutline: 0.3,
};

// ---------------------------------------------------------------------------
// 3. Small geometry helpers (local to the renderer; intentionally NOT shared
//    with town/geom.js so this file stays dependency-free per CONTRACTS.md).
// ---------------------------------------------------------------------------

/** Build an SVG path "d" string for a Polygon (Ring[]) using evenodd fill
 * so holes (ring[1..]) cut out of the outer ring (ring[0]) correctly.
 * Tolerates rings that do or do not repeat their first vertex. */
function polygonToPath(rings) {
  if (!Array.isArray(rings) || rings.length === 0) return '';
  let d = '';
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 2) continue;
    d += ringToSubpath(ring);
  }
  return d;
}

/** One closed subpath ("M x,y L x,y ... Z") for a single ring. */
function ringToSubpath(ring) {
  let d = '';
  for (let i = 0; i < ring.length; i++) {
    const pt = ring[i];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [x, y] = pt;
    d += (i === 0 ? `M${fmt(x)},${fmt(y)}` : `L${fmt(x)},${fmt(y)}`);
  }
  d += 'Z';
  return d;
}

/** Build a "d" string for an open LineString (Pt[]). */
function lineToPath(points) {
  if (!Array.isArray(points) || points.length < 2) return '';
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [x, y] = pt;
    d += (i === 0 ? `M${fmt(x)},${fmt(y)}` : `L${fmt(x)},${fmt(y)}`);
  }
  return d;
}

/** Trim float noise from coordinates to keep markup compact & stable. */
function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  // 2 decimal places is plenty at metre scale.
  return Math.round(n * 100) / 100;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) {
        el.setAttribute(key, attrs[key]);
      }
    }
  }
  return el;
}

/** Safe accessor: returns a layer array, or [] if missing/not an array. */
function layerOf(layers, name) {
  if (!layers) return [];
  const v = layers[name];
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// 4. Layer renderers — one per TownModel layer, each fully defensive.
// ---------------------------------------------------------------------------

/** Render a Polygon[] layer as filled shapes (evenodd, with holes). */
function renderPolygonLayer(group, polygons, { fill, stroke = 'none', strokeWidthPx = 0, opacity }) {
  if (!Array.isArray(polygons) || polygons.length === 0) return;
  for (const polygon of polygons) {
    const d = polygonToPath(polygon);
    if (!d) continue;
    const attrs = {
      d,
      'fill-rule': 'evenodd',
      fill,
      stroke,
    };
    if (strokeWidthPx > 0) attrs['stroke-width'] = fmt(strokeWidthPx);
    if (opacity !== undefined) attrs['fill-opacity'] = opacity;
    group.appendChild(svgEl('path', attrs));
  }
}

/** Render a LineString[] layer as open strokes with round caps/joins. */
function renderLineLayer(group, lines, { stroke, widthPx, dasharray, opacity }) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  for (const line of lines) {
    const d = lineToPath(line);
    if (!d) continue;
    const attrs = {
      d,
      fill: 'none',
      stroke,
      'stroke-width': fmt(Math.max(widthPx, 0.01)),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    };
    if (dasharray) attrs['stroke-dasharray'] = dasharray;
    if (opacity !== undefined) attrs['stroke-opacity'] = opacity;
    group.appendChild(svgEl('path', attrs));
  }
}

/** Render Pt[] as small filled circles (trees / fountains / wells / boulders). */
function renderPointLayer(group, points, { fill, radiusPx, stroke, strokeWidthPx }) {
  if (!Array.isArray(points) || points.length === 0) return;
  for (const pt of points) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [x, y] = pt;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const attrs = {
      cx: fmt(x),
      cy: fmt(y),
      r: fmt(Math.max(radiusPx, 0.05)),
      fill,
    };
    if (stroke) {
      attrs.stroke = stroke;
      attrs['stroke-width'] = fmt(strokeWidthPx || 0.2);
    }
    group.appendChild(svgEl('circle', attrs));
  }
}

/** Bridge/plank glyph: the centerline stroke plus a couple of perpendicular
 * tie ticks evenly spaced along it, evoking a plank crossing symbol. */
function renderPlanks(group, planks, pxPerMetre) {
  if (!Array.isArray(planks) || planks.length === 0) return;
  const widthPx = WEIGHTS.plankWidth * pxPerMetre;
  const tickLenPx = WEIGHTS.plankTickLength * pxPerMetre;

  for (const line of planks) {
    if (!Array.isArray(line) || line.length < 2) continue;
    // Centerline.
    const d = lineToPath(line);
    if (d) {
      group.appendChild(svgEl('path', {
        d,
        fill: 'none',
        stroke: COLORS.black,
        'stroke-width': fmt(Math.max(widthPx, 0.01)),
        'stroke-linecap': 'butt',
        'stroke-linejoin': 'round',
      }));
    }
    // Tie ticks: one at the midpoint of each segment, perpendicular to it.
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const [ax, ay] = a;
      const [bx, by] = b;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      // Perpendicular unit vector.
      const px = -dy / len;
      const py = dx / len;
      const halfTick = tickLenPx / pxPerMetre / 2; // back to metres for endpoint math
      const x1 = mx - px * halfTick;
      const y1 = my - py * halfTick;
      const x2 = mx + px * halfTick;
      const y2 = my + py * halfTick;
      group.appendChild(svgEl('line', {
        x1: fmt(x1), y1: fmt(y1), x2: fmt(x2), y2: fmt(y2),
        stroke: COLORS.black,
        'stroke-width': fmt(Math.max(widthPx * 0.7, 0.01)),
        'stroke-linecap': 'butt',
      }));
    }
  }
}

/** Hedges: dark-green band, similar treatment to walls but olive/green. */
function renderHedges(group, hedges, pxPerMetre) {
  if (!Array.isArray(hedges) || hedges.length === 0) return;
  const widthPx = WEIGHTS.hedgeWidth * pxPerMetre;
  renderLineLayer(group, hedges, { stroke: COLORS.greenImpassable, widthPx });
}

// ---------------------------------------------------------------------------
// 5. Main entry point.
// ---------------------------------------------------------------------------

/**
 * Render a TownModel into an existing <svg> DOM element.
 *
 * @param {object} townModel  A TownModel per CONTRACTS.md §2.
 * @param {SVGSVGElement} svgElement  The target <svg> element; cleared first.
 * @param {object} [opts]
 * @param {string} [opts.background]   Page background colour drawn behind
 *                                      everything (defaults to none/transparent).
 * @param {boolean} [opts.showDistricts] Draw a faint outline of layers.districts
 *                                        (ward/patch boundaries) for debugging.
 * @param {number} [opts.margin=0.04]   Fractional margin added around bbox
 *                                       (0.04 = 4% of the larger bbox dimension).
 */
export function renderTown(townModel, svgElement, opts = {}) {
  if (!svgElement || typeof svgElement.appendChild !== 'function') {
    // Nothing sane to draw into — bail out quietly rather than throwing,
    // per the "never throw" robustness requirement.
    return;
  }

  // Clear any previous render.
  while (svgElement.firstChild) {
    svgElement.removeChild(svgElement.firstChild);
  }

  const model = townModel && typeof townModel === 'object' ? townModel : {};
  const meta = model.meta && typeof model.meta === 'object' ? model.meta : {};
  const layers = model.layers && typeof model.layers === 'object' ? model.layers : {};

  // ---- 5a. Compute viewBox from meta.bbox, with a small margin -----------
  let [minx, miny, maxx, maxy] = Array.isArray(meta.bbox) && meta.bbox.length === 4
    ? meta.bbox
    : [0, 0, 1, 1];

  if (!Number.isFinite(minx) || !Number.isFinite(miny) ||
      !Number.isFinite(maxx) || !Number.isFinite(maxy) ||
      maxx <= minx || maxy <= miny) {
    // Degenerate/missing bbox — fall back to a unit box so we still render
    // without throwing (real towns will always have a valid bbox).
    minx = 0; miny = 0; maxx = 1; maxy = 1;
  }

  const widthM = maxx - minx;
  const heightM = maxy - miny;
  const marginFrac = Number.isFinite(opts.margin) ? opts.margin : 0.04;
  const marginM = Math.max(widthM, heightM) * marginFrac;

  const vbX = minx - marginM;
  const vbY = miny - marginM;
  const vbW = widthM + marginM * 2;
  const vbH = heightM + marginM * 2;

  svgElement.setAttribute('viewBox', `${fmt(vbX)} ${fmt(vbY)} ${fmt(vbW)} ${fmt(vbH)}`);
  svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // ---- 5b. px-per-metre, derived from the rendered viewBox size ----------
  // Per CONTRACTS.md §4: "scaled to px via the renderer's px-per-metre
  // (viewBoxPx / sizeM)". The viewBox IS in metres (SVG user units == our
  // model metres), so 1 viewBox unit == 1 px-equivalent here; pxPerMetre is
  // simply 1. We still compute it explicitly (using meta.sizeM when present,
  // else the bbox's larger dimension) so stroke widths stay correct even if
  // a caller later rescales the <svg> element's CSS width/height — SVG
  // stroke-width is specified in user-space (viewBox) units, which is what
  // we want regardless of on-screen pixel size.
  const sizeM = Number.isFinite(meta.sizeM) && meta.sizeM > 0
    ? meta.sizeM
    : Math.max(widthM, heightM) || 1;
  const viewBoxPx = Math.max(vbW, vbH);
  const pxPerMetre = viewBoxPx / sizeM;

  // ---- 5c. Optional page background --------------------------------------
  if (opts.background) {
    svgElement.appendChild(svgEl('rect', {
      x: fmt(vbX), y: fmt(vbY), width: fmt(vbW), height: fmt(vbH),
      fill: opts.background,
    }));
  }

  // One <g> per draw-order step keeps the resulting markup easy to inspect
  // and lets callers toggle layers via CSS if desired.
  const gEarth = svgEl('g', { class: 'isom-earth' });
  const gFields = svgEl('g', { class: 'isom-fields' });
  const gGreens = svgEl('g', { class: 'isom-greens' });
  const gSquares = svgEl('g', { class: 'isom-squares' });
  const gRoads = svgEl('g', { class: 'isom-roads' });
  const gWater = svgEl('g', { class: 'isom-water' });
  const gRivers = svgEl('g', { class: 'isom-rivers' });
  const gBlocks = svgEl('g', { class: 'isom-blocks' });
  const gBuildings = svgEl('g', { class: 'isom-buildings' });
  const gWalls = svgEl('g', { class: 'isom-walls' });
  const gHedges = svgEl('g', { class: 'isom-hedges' });
  const gPlanks = svgEl('g', { class: 'isom-planks' });
  const gPoints = svgEl('g', { class: 'isom-points' });
  const gDistricts = svgEl('g', { class: 'isom-districts' });

  // Draw order back -> front per CONTRACTS.md §4.
  svgElement.appendChild(gEarth);
  svgElement.appendChild(gFields);
  svgElement.appendChild(gGreens);
  svgElement.appendChild(gSquares);
  svgElement.appendChild(gRoads);
  svgElement.appendChild(gWater);
  svgElement.appendChild(gRivers);
  svgElement.appendChild(gBlocks);
  svgElement.appendChild(gBuildings);
  svgElement.appendChild(gWalls);
  svgElement.appendChild(gHedges);
  svgElement.appendChild(gPlanks);
  svgElement.appendChild(gPoints);
  // Districts are debug-only; keep them on top (with low opacity) so they
  // remain visible over fills without obscuring symbology.
  svgElement.appendChild(gDistricts);

  // ---- 1. earth — open-land base fill (yellow) ----------------------------
  renderPolygonLayer(gEarth, layerOf(layers, 'earth'), {
    fill: COLORS.openLand,
    stroke: 'none',
  });

  // ---- 2. fields (olive) / greens (green) ---------------------------------
  renderPolygonLayer(gFields, layerOf(layers, 'fields'), {
    fill: COLORS.olive,
    stroke: 'none',
  });
  renderPolygonLayer(gGreens, layerOf(layers, 'greens'), {
    fill: COLORS.greenSlow,
    stroke: 'none',
  });

  // ---- 3. squares (paved grey) / roads (paved stroke) ---------------------
  renderPolygonLayer(gSquares, layerOf(layers, 'squares'), {
    fill: COLORS.pavedLight,
    stroke: COLORS.pavedDark,
    strokeWidthPx: 0.2 * pxPerMetre,
  });
  const roadWidthM = Number.isFinite(meta.roadWidth) && meta.roadWidth > 0
    ? meta.roadWidth
    : WEIGHTS.roadWidth;
  renderLineLayer(gRoads, layerOf(layers, 'roads'), {
    stroke: COLORS.pavedDark,
    widthPx: roadWidthM * pxPerMetre,
  });

  // ---- 4. water (blue fill + bank) / rivers (blue stroke) -----------------
  renderPolygonLayer(gWater, layerOf(layers, 'water'), {
    fill: COLORS.waterFill,
    stroke: COLORS.waterBank,
    strokeWidthPx: WEIGHTS.waterBankWidth * pxPerMetre,
  });
  const riverWidthM = Number.isFinite(meta.riverWidth) && meta.riverWidth > 0
    ? meta.riverWidth
    : WEIGHTS.riverWidth;
  renderLineLayer(gRivers, layerOf(layers, 'rivers'), {
    stroke: COLORS.waterFill,
    widthPx: riverWidthM * pxPerMetre,
  });

  // ---- 4b. blocks — kept in the model as the pathfinding obstacle (the solid
  //          mass a route goes around) but NOT filled here: the touching
  //          individual buildings below already convey the block, and a solid
  //          fill underneath produced featureless black blobs. Optional debug
  //          outline only. ---------------------------------------------------
  if (opts.showBlocks) {
    renderPolygonLayer(gBlocks, layerOf(layers, 'blocks'), {
      fill: 'none',
      stroke: COLORS.overprint,
      strokeWidthPx: 0.4 * pxPerMetre,
      opacity: 0.5,
    });
  }

  // ---- 5. buildings + prisms. Buildings are individual footprints that TOUCH
  //          (share walls) within a block; the light SEAM stroke makes each
  //          house read as a separate cell (the Watabou "blocks of houses"
  //          look). Prisms (castle/cathedral landmarks) stay solid black. ----
  renderPolygonLayer(gBuildings, layerOf(layers, 'buildings'), {
    fill: COLORS.black,
    stroke: COLORS.seam,
    strokeWidthPx: Math.max(WEIGHTS.buildingSeam * pxPerMetre, 0.3),
  });
  renderPolygonLayer(gBuildings, layerOf(layers, 'prisms'), {
    fill: COLORS.black,
    stroke: COLORS.black,
    strokeWidthPx: WEIGHTS.buildingOutline * pxPerMetre,
  });

  // ---- 6. walls (solid black stroke) / hedges (dark-green band) ----------
  const wallThicknessM = Number.isFinite(meta.wallThickness) && meta.wallThickness > 0
    ? meta.wallThickness
    : WEIGHTS.wallThickness;
  // Walls are stored as closed Polygon rings (a wall "ring"), but visually
  // they read as a thick stroke tracing the ring rather than a filled area,
  // so render the outer ring of each wall polygon as a closed stroked path
  // (fill: none) at wallThickness width.
  for (const wallPolygon of layerOf(layers, 'walls')) {
    if (!Array.isArray(wallPolygon) || wallPolygon.length === 0) continue;
    const outer = wallPolygon[0];
    const d = ringToSubpath(outer);
    if (!d || d === 'MZ') continue;
    gWalls.appendChild(svgEl('path', {
      d,
      fill: 'none',
      stroke: COLORS.black,
      'stroke-width': fmt(Math.max(wallThicknessM * pxPerMetre, 0.01)),
      'stroke-linejoin': 'round',
    }));
  }
  renderHedges(gHedges, layerOf(layers, 'hedges'), pxPerMetre);

  // ---- 7. planks — bridge/crossing glyph over water -----------------------
  renderPlanks(gPlanks, layerOf(layers, 'planks'), pxPerMetre);

  // ---- 8. trees (green dot) / fountains, wells (blue point) / boulders ---
  renderPointLayer(gPoints, layerOf(layers, 'trees'), {
    fill: COLORS.greenImpassable,
    radiusPx: WEIGHTS.treeRadius * pxPerMetre,
  });
  renderPointLayer(gPoints, layerOf(layers, 'fountains'), {
    fill: COLORS.waterFill,
    radiusPx: WEIGHTS.fountainRadius * pxPerMetre,
    stroke: COLORS.black,
    strokeWidthPx: 0.2 * pxPerMetre,
  });
  renderPointLayer(gPoints, layerOf(layers, 'wells'), {
    fill: COLORS.waterFill,
    radiusPx: WEIGHTS.wellRadius * pxPerMetre,
    stroke: COLORS.black,
    strokeWidthPx: 0.2 * pxPerMetre,
  });
  renderPointLayer(gPoints, layerOf(layers, 'boulders'), {
    fill: COLORS.black,
    radiusPx: WEIGHTS.boulderRadius * pxPerMetre,
  });
  // Wall towers (bastions) — solid black circles on the curtain wall.
  const towerRadiusM = Number.isFinite(meta.towerRadius) && meta.towerRadius > 0
    ? meta.towerRadius
    : WEIGHTS.boulderRadius;
  renderPointLayer(gPoints, layerOf(layers, 'towers'), {
    fill: COLORS.black,
    radiusPx: towerRadiusM * pxPerMetre,
  });

  // ---- optional: faint district outline (debug aid) -----------------------
  if (opts.showDistricts) {
    renderPolygonLayer(gDistricts, layerOf(layers, 'districts'), {
      fill: 'none',
      stroke: COLORS.overprint,
      strokeWidthPx: WEIGHTS.districtOutline * pxPerMetre,
      opacity: 0.5,
    });
  }
}

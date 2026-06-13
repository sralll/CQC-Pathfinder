(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
"use strict";Object.defineProperty(exports, "__esModule", {value: true});// index.ts
var earthRadius = 63710088e-1;
var factors = {
  centimeters: earthRadius * 100,
  centimetres: earthRadius * 100,
  degrees: 360 / (2 * Math.PI),
  feet: earthRadius * 3.28084,
  inches: earthRadius * 39.37,
  kilometers: earthRadius / 1e3,
  kilometres: earthRadius / 1e3,
  meters: earthRadius,
  metres: earthRadius,
  miles: earthRadius / 1609.344,
  millimeters: earthRadius * 1e3,
  millimetres: earthRadius * 1e3,
  nauticalmiles: earthRadius / 1852,
  radians: 1,
  yards: earthRadius * 1.0936
};
var areaFactors = {
  acres: 247105e-9,
  centimeters: 1e4,
  centimetres: 1e4,
  feet: 10.763910417,
  hectares: 1e-4,
  inches: 1550.003100006,
  kilometers: 1e-6,
  kilometres: 1e-6,
  meters: 1,
  metres: 1,
  miles: 386e-9,
  nauticalmiles: 29155334959812285e-23,
  millimeters: 1e6,
  millimetres: 1e6,
  yards: 1.195990046
};
function feature(geom, properties, options = {}) {
  const feat = { type: "Feature" };
  if (options.id === 0 || options.id) {
    feat.id = options.id;
  }
  if (options.bbox) {
    feat.bbox = options.bbox;
  }
  feat.properties = properties || {};
  feat.geometry = geom;
  return feat;
}
function geometry(type, coordinates, _options = {}) {
  switch (type) {
    case "Point":
      return point(coordinates).geometry;
    case "LineString":
      return lineString(coordinates).geometry;
    case "Polygon":
      return polygon(coordinates).geometry;
    case "MultiPoint":
      return multiPoint(coordinates).geometry;
    case "MultiLineString":
      return multiLineString(coordinates).geometry;
    case "MultiPolygon":
      return multiPolygon(coordinates).geometry;
    default:
      throw new Error(type + " is invalid");
  }
}
function point(coordinates, properties, options = {}) {
  if (!coordinates) {
    throw new Error("coordinates is required");
  }
  if (!Array.isArray(coordinates)) {
    throw new Error("coordinates must be an Array");
  }
  if (coordinates.length < 2) {
    throw new Error("coordinates must be at least 2 numbers long");
  }
  if (!isNumber(coordinates[0]) || !isNumber(coordinates[1])) {
    throw new Error("coordinates must contain numbers");
  }
  const geom = {
    type: "Point",
    coordinates
  };
  return feature(geom, properties, options);
}
function points(coordinates, properties, options = {}) {
  return featureCollection(
    coordinates.map((coords) => {
      return point(coords, properties);
    }),
    options
  );
}
function polygon(coordinates, properties, options = {}) {
  for (const ring of coordinates) {
    if (ring.length < 4) {
      throw new Error(
        "Each LinearRing of a Polygon must have 4 or more Positions."
      );
    }
    if (ring[ring.length - 1].length !== ring[0].length) {
      throw new Error("First and last Position are not equivalent.");
    }
    for (let j = 0; j < ring[ring.length - 1].length; j++) {
      if (ring[ring.length - 1][j] !== ring[0][j]) {
        throw new Error("First and last Position are not equivalent.");
      }
    }
  }
  const geom = {
    type: "Polygon",
    coordinates
  };
  return feature(geom, properties, options);
}
function polygons(coordinates, properties, options = {}) {
  return featureCollection(
    coordinates.map((coords) => {
      return polygon(coords, properties);
    }),
    options
  );
}
function lineString(coordinates, properties, options = {}) {
  if (coordinates.length < 2) {
    throw new Error("coordinates must be an array of two or more positions");
  }
  const geom = {
    type: "LineString",
    coordinates
  };
  return feature(geom, properties, options);
}
function lineStrings(coordinates, properties, options = {}) {
  return featureCollection(
    coordinates.map((coords) => {
      return lineString(coords, properties);
    }),
    options
  );
}
function featureCollection(features, options = {}) {
  const fc = { type: "FeatureCollection" };
  if (options.id) {
    fc.id = options.id;
  }
  if (options.bbox) {
    fc.bbox = options.bbox;
  }
  fc.features = features;
  return fc;
}
function multiLineString(coordinates, properties, options = {}) {
  const geom = {
    type: "MultiLineString",
    coordinates
  };
  return feature(geom, properties, options);
}
function multiPoint(coordinates, properties, options = {}) {
  const geom = {
    type: "MultiPoint",
    coordinates
  };
  return feature(geom, properties, options);
}
function multiPolygon(coordinates, properties, options = {}) {
  const geom = {
    type: "MultiPolygon",
    coordinates
  };
  return feature(geom, properties, options);
}
function geometryCollection(geometries, properties, options = {}) {
  const geom = {
    type: "GeometryCollection",
    geometries
  };
  return feature(geom, properties, options);
}
function round(num, precision = 0) {
  if (precision && !(precision >= 0)) {
    throw new Error("precision must be a positive number");
  }
  const multiplier = Math.pow(10, precision || 0);
  return Math.round(num * multiplier) / multiplier;
}
function radiansToLength(radians, units = "kilometers") {
  const factor = factors[units];
  if (!factor) {
    throw new Error(units + " units is invalid");
  }
  return radians * factor;
}
function lengthToRadians(distance, units = "kilometers") {
  const factor = factors[units];
  if (!factor) {
    throw new Error(units + " units is invalid");
  }
  return distance / factor;
}
function lengthToDegrees(distance, units) {
  return radiansToDegrees(lengthToRadians(distance, units));
}
function bearingToAzimuth(bearing) {
  let angle = bearing % 360;
  if (angle < 0) {
    angle += 360;
  }
  return angle;
}
function azimuthToBearing(angle) {
  angle = angle % 360;
  if (angle > 180) {
    return angle - 360;
  } else if (angle < -180) {
    return angle + 360;
  }
  return angle;
}
function radiansToDegrees(radians) {
  const normalisedRadians = radians % (2 * Math.PI);
  return normalisedRadians * 180 / Math.PI;
}
function degreesToRadians(degrees) {
  const normalisedDegrees = degrees % 360;
  return normalisedDegrees * Math.PI / 180;
}
function convertLength(length, originalUnit = "kilometers", finalUnit = "kilometers") {
  if (!(length >= 0)) {
    throw new Error("length must be a positive number");
  }
  return radiansToLength(lengthToRadians(length, originalUnit), finalUnit);
}
function convertArea(area, originalUnit = "meters", finalUnit = "kilometers") {
  if (!(area >= 0)) {
    throw new Error("area must be a positive number");
  }
  const startFactor = areaFactors[originalUnit];
  if (!startFactor) {
    throw new Error("invalid original units");
  }
  const finalFactor = areaFactors[finalUnit];
  if (!finalFactor) {
    throw new Error("invalid final units");
  }
  return area / startFactor * finalFactor;
}
function isNumber(num) {
  return !isNaN(num) && num !== null && !Array.isArray(num);
}
function isObject(input) {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
function validateBBox(bbox) {
  if (!bbox) {
    throw new Error("bbox is required");
  }
  if (!Array.isArray(bbox)) {
    throw new Error("bbox must be an Array");
  }
  if (bbox.length !== 4 && bbox.length !== 6) {
    throw new Error("bbox must be an Array of 4 or 6 numbers");
  }
  bbox.forEach((num) => {
    if (!isNumber(num)) {
      throw new Error("bbox must only contain numbers");
    }
  });
}
function validateId(id) {
  if (!id) {
    throw new Error("id is required");
  }
  if (["string", "number"].indexOf(typeof id) === -1) {
    throw new Error("id must be a number or a string");
  }
}































exports.areaFactors = areaFactors; exports.azimuthToBearing = azimuthToBearing; exports.bearingToAzimuth = bearingToAzimuth; exports.convertArea = convertArea; exports.convertLength = convertLength; exports.degreesToRadians = degreesToRadians; exports.earthRadius = earthRadius; exports.factors = factors; exports.feature = feature; exports.featureCollection = featureCollection; exports.geometry = geometry; exports.geometryCollection = geometryCollection; exports.isNumber = isNumber; exports.isObject = isObject; exports.lengthToDegrees = lengthToDegrees; exports.lengthToRadians = lengthToRadians; exports.lineString = lineString; exports.lineStrings = lineStrings; exports.multiLineString = multiLineString; exports.multiPoint = multiPoint; exports.multiPolygon = multiPolygon; exports.point = point; exports.points = points; exports.polygon = polygon; exports.polygons = polygons; exports.radiansToDegrees = radiansToDegrees; exports.radiansToLength = radiansToLength; exports.round = round; exports.validateBBox = validateBBox; exports.validateId = validateId;

},{}],2:[function(require,module,exports){
"use strict";Object.defineProperty(exports, "__esModule", {value: true});// index.ts
var _helpers = require('@turf/helpers');
function getCoord(coord) {
  if (!coord) {
    throw new Error("coord is required");
  }
  if (!Array.isArray(coord)) {
    if (coord.type === "Feature" && coord.geometry !== null && coord.geometry.type === "Point") {
      return [...coord.geometry.coordinates];
    }
    if (coord.type === "Point") {
      return [...coord.coordinates];
    }
  }
  if (Array.isArray(coord) && coord.length >= 2 && !Array.isArray(coord[0]) && !Array.isArray(coord[1])) {
    return [...coord];
  }
  throw new Error("coord must be GeoJSON Point or an Array of numbers");
}
function getCoords(coords) {
  if (Array.isArray(coords)) {
    return coords;
  }
  if (coords.type === "Feature") {
    if (coords.geometry !== null) {
      return coords.geometry.coordinates;
    }
  } else {
    if (coords.coordinates) {
      return coords.coordinates;
    }
  }
  throw new Error(
    "coords must be GeoJSON Feature, Geometry Object or an Array"
  );
}
function containsNumber(coordinates) {
  if (coordinates.length > 1 && _helpers.isNumber.call(void 0, coordinates[0]) && _helpers.isNumber.call(void 0, coordinates[1])) {
    return true;
  }
  if (Array.isArray(coordinates[0]) && coordinates[0].length) {
    return containsNumber(coordinates[0]);
  }
  throw new Error("coordinates must only contain numbers");
}
function geojsonType(value, type, name) {
  if (!type || !name) {
    throw new Error("type and name required");
  }
  if (!value || value.type !== type) {
    throw new Error(
      "Invalid input to " + name + ": must be a " + type + ", given " + value.type
    );
  }
}
function featureOf(feature, type, name) {
  if (!feature) {
    throw new Error("No feature passed");
  }
  if (!name) {
    throw new Error(".featureOf() requires a name");
  }
  if (!feature || feature.type !== "Feature" || !feature.geometry) {
    throw new Error(
      "Invalid input to " + name + ", Feature with geometry required"
    );
  }
  if (!feature.geometry || feature.geometry.type !== type) {
    throw new Error(
      "Invalid input to " + name + ": must be a " + type + ", given " + feature.geometry.type
    );
  }
}
function collectionOf(featureCollection, type, name) {
  if (!featureCollection) {
    throw new Error("No featureCollection passed");
  }
  if (!name) {
    throw new Error(".collectionOf() requires a name");
  }
  if (!featureCollection || featureCollection.type !== "FeatureCollection") {
    throw new Error(
      "Invalid input to " + name + ", FeatureCollection required"
    );
  }
  for (const feature of featureCollection.features) {
    if (!feature || feature.type !== "Feature" || !feature.geometry) {
      throw new Error(
        "Invalid input to " + name + ", Feature with geometry required"
      );
    }
    if (!feature.geometry || feature.geometry.type !== type) {
      throw new Error(
        "Invalid input to " + name + ": must be a " + type + ", given " + feature.geometry.type
      );
    }
  }
}
function getGeom(geojson) {
  if (geojson.type === "Feature") {
    return geojson.geometry;
  }
  return geojson;
}
function getType(geojson, _name) {
  if (geojson.type === "FeatureCollection") {
    return "FeatureCollection";
  }
  if (geojson.type === "GeometryCollection") {
    return "GeometryCollection";
  }
  if (geojson.type === "Feature" && geojson.geometry !== null) {
    return geojson.geometry.type;
  }
  return geojson.type;
}









exports.collectionOf = collectionOf; exports.containsNumber = containsNumber; exports.featureOf = featureOf; exports.geojsonType = geojsonType; exports.getCoord = getCoord; exports.getCoords = getCoords; exports.getGeom = getGeom; exports.getType = getType;

},{"@turf/helpers":1}],3:[function(require,module,exports){
"use strict";Object.defineProperty(exports, "__esModule", {value: true});// index.ts
var _meta = require('@turf/meta');
var _invariant = require('@turf/invariant');





var _helpers = require('@turf/helpers');

// lib/intersection.ts
function ab(segment) {
  var start = segment[0];
  var end = segment[1];
  return [end[0] - start[0], end[1] - start[1]];
}
function crossProduct(v1, v2) {
  return v1[0] * v2[1] - v2[0] * v1[1];
}
function add(v1, v2) {
  return [v1[0] + v2[0], v1[1] + v2[1]];
}
function sub(v1, v2) {
  return [v1[0] - v2[0], v1[1] - v2[1]];
}
function scalarMult(s, v) {
  return [s * v[0], s * v[1]];
}
function intersectSegments(a, b) {
  var p = a[0];
  var r = ab(a);
  var q = b[0];
  var s = ab(b);
  var cross = crossProduct(r, s);
  var qmp = sub(q, p);
  var numerator = crossProduct(qmp, s);
  var t = numerator / cross;
  var intersection2 = add(p, scalarMult(t, r));
  return intersection2;
}
function isParallel(a, b) {
  var r = ab(a);
  var s = ab(b);
  return crossProduct(r, s) === 0;
}
function intersection(a, b) {
  if (isParallel(a, b)) return false;
  return intersectSegments(a, b);
}

// index.ts
function lineOffset(geojson, distance, options = {}) {
  options = options || {};
  if (!_helpers.isObject.call(void 0, options)) throw new Error("options is invalid");
  const { units = "kilometers" } = options;
  if (!geojson) throw new Error("geojson is required");
  if (distance === void 0 || distance === null || isNaN(distance))
    throw new Error("distance is required");
  var type = _invariant.getType.call(void 0, geojson);
  var properties = geojson.type === "Feature" ? geojson.properties : {};
  switch (type) {
    case "LineString":
      return lineOffsetFeature(geojson, distance, units);
    case "MultiLineString":
      var coords = [];
      _meta.flattenEach.call(void 0, geojson, function(feature) {
        coords.push(
          lineOffsetFeature(feature, distance, units).geometry.coordinates
        );
      });
      return _helpers.multiLineString.call(void 0, coords, properties);
    default:
      throw new Error("geometry " + type + " is not supported");
  }
}
function lineOffsetFeature(line, distance, units) {
  var segments = [];
  var offsetDegrees = _helpers.lengthToDegrees.call(void 0, distance, units);
  var coords = _invariant.getCoords.call(void 0, line);
  var finalCoords = [];
  coords.forEach(function(currentCoords, index) {
    if (index !== coords.length - 1) {
      var segment = processSegment(
        currentCoords,
        coords[index + 1],
        offsetDegrees
      );
      segments.push(segment);
      if (index > 0) {
        var seg2Coords = segments[index - 1];
        var intersects = intersection(segment, seg2Coords);
        if (intersects !== false) {
          seg2Coords[1] = intersects;
          segment[0] = intersects;
        }
        finalCoords.push(seg2Coords[0]);
        if (index === coords.length - 2) {
          finalCoords.push(segment[0]);
          finalCoords.push(segment[1]);
        }
      }
      if (coords.length === 2) {
        finalCoords.push(segment[0]);
        finalCoords.push(segment[1]);
      }
    }
  });
  return _helpers.lineString.call(void 0, 
    finalCoords,
    line.type === "Feature" ? line.properties : {}
  );
}
function processSegment(point1, point2, offset) {
  var L = Math.sqrt(
    (point1[0] - point2[0]) * (point1[0] - point2[0]) + (point1[1] - point2[1]) * (point1[1] - point2[1])
  );
  var out1x = point1[0] + offset * (point2[1] - point1[1]) / L;
  var out2x = point2[0] + offset * (point2[1] - point1[1]) / L;
  var out1y = point1[1] + offset * (point1[0] - point2[0]) / L;
  var out2y = point2[1] + offset * (point1[0] - point2[0]) / L;
  return [
    [out1x, out1y],
    [out2x, out2y]
  ];
}
var index_default = lineOffset;



exports.default = index_default; exports.lineOffset = lineOffset;

},{"@turf/helpers":1,"@turf/invariant":2,"@turf/meta":4}],4:[function(require,module,exports){
"use strict";Object.defineProperty(exports, "__esModule", {value: true});// index.ts
var _helpers = require('@turf/helpers');
function coordEach(geojson, callback, excludeWrapCoord) {
  if (geojson === null) return;
  var j, k, l, geometry, stopG, coords, geometryMaybeCollection, wrapShrink = 0, coordIndex = 0, isGeometryCollection, type = geojson.type, isFeatureCollection = type === "FeatureCollection", isFeature = type === "Feature", stop = isFeatureCollection ? geojson.features.length : 1;
  for (var featureIndex = 0; featureIndex < stop; featureIndex++) {
    geometryMaybeCollection = isFeatureCollection ? (
      // @ts-expect-error: Known type conflict
      geojson.features[featureIndex].geometry
    ) : isFeature ? (
      // @ts-expect-error: Known type conflict
      geojson.geometry
    ) : geojson;
    isGeometryCollection = geometryMaybeCollection ? geometryMaybeCollection.type === "GeometryCollection" : false;
    stopG = isGeometryCollection ? geometryMaybeCollection.geometries.length : 1;
    for (var geomIndex = 0; geomIndex < stopG; geomIndex++) {
      var multiFeatureIndex = 0;
      var geometryIndex = 0;
      geometry = isGeometryCollection ? geometryMaybeCollection.geometries[geomIndex] : geometryMaybeCollection;
      if (geometry === null) continue;
      coords = geometry.coordinates;
      var geomType = geometry.type;
      wrapShrink = excludeWrapCoord && (geomType === "Polygon" || geomType === "MultiPolygon") ? 1 : 0;
      switch (geomType) {
        case null:
          break;
        case "Point":
          if (
            // @ts-expect-error: Known type conflict
            callback(
              coords,
              coordIndex,
              featureIndex,
              multiFeatureIndex,
              geometryIndex
            ) === false
          )
            return false;
          coordIndex++;
          multiFeatureIndex++;
          break;
        case "LineString":
        case "MultiPoint":
          for (j = 0; j < coords.length; j++) {
            if (
              // @ts-expect-error: Known type conflict
              callback(
                coords[j],
                coordIndex,
                featureIndex,
                multiFeatureIndex,
                geometryIndex
              ) === false
            )
              return false;
            coordIndex++;
            if (geomType === "MultiPoint") multiFeatureIndex++;
          }
          if (geomType === "LineString") multiFeatureIndex++;
          break;
        case "Polygon":
        case "MultiLineString":
          for (j = 0; j < coords.length; j++) {
            for (k = 0; k < coords[j].length - wrapShrink; k++) {
              if (
                // @ts-expect-error: Known type conflict
                callback(
                  coords[j][k],
                  coordIndex,
                  featureIndex,
                  multiFeatureIndex,
                  geometryIndex
                ) === false
              )
                return false;
              coordIndex++;
            }
            if (geomType === "MultiLineString") multiFeatureIndex++;
            if (geomType === "Polygon") geometryIndex++;
          }
          if (geomType === "Polygon") multiFeatureIndex++;
          break;
        case "MultiPolygon":
          for (j = 0; j < coords.length; j++) {
            geometryIndex = 0;
            for (k = 0; k < coords[j].length; k++) {
              for (l = 0; l < coords[j][k].length - wrapShrink; l++) {
                if (
                  // @ts-expect-error: Known type conflict
                  callback(
                    coords[j][k][l],
                    coordIndex,
                    featureIndex,
                    multiFeatureIndex,
                    geometryIndex
                  ) === false
                )
                  return false;
                coordIndex++;
              }
              geometryIndex++;
            }
            multiFeatureIndex++;
          }
          break;
        case "GeometryCollection":
          for (j = 0; j < geometry.geometries.length; j++)
            if (
              // @ts-expect-error: Known type conflict
              coordEach(geometry.geometries[j], callback, excludeWrapCoord) === false
            )
              return false;
          break;
        default:
          throw new Error("Unknown Geometry Type");
      }
    }
  }
}
function coordReduce(geojson, callback, initialValue, excludeWrapCoord) {
  var previousValue = initialValue;
  coordEach(
    geojson,
    function(currentCoord, coordIndex, featureIndex, multiFeatureIndex, geometryIndex) {
      if (coordIndex === 0 && initialValue === void 0)
        previousValue = currentCoord;
      else
        previousValue = callback(
          // @ts-expect-error: Known type conflict
          previousValue,
          currentCoord,
          coordIndex,
          featureIndex,
          multiFeatureIndex,
          geometryIndex
        );
    },
    excludeWrapCoord
  );
  return previousValue;
}
function propEach(geojson, callback) {
  var i;
  switch (geojson.type) {
    case "FeatureCollection":
      for (i = 0; i < geojson.features.length; i++) {
        if (callback(geojson.features[i].properties, i) === false) break;
      }
      break;
    case "Feature":
      callback(geojson.properties, 0);
      break;
  }
}
function propReduce(geojson, callback, initialValue) {
  var previousValue = initialValue;
  propEach(geojson, function(currentProperties, featureIndex) {
    if (featureIndex === 0 && initialValue === void 0)
      previousValue = currentProperties;
    else
      previousValue = callback(previousValue, currentProperties, featureIndex);
  });
  return previousValue;
}
function featureEach(geojson, callback) {
  if (geojson.type === "Feature") {
    callback(geojson, 0);
  } else if (geojson.type === "FeatureCollection") {
    for (var i = 0; i < geojson.features.length; i++) {
      if (callback(geojson.features[i], i) === false) break;
    }
  }
}
function featureReduce(geojson, callback, initialValue) {
  var previousValue = initialValue;
  featureEach(geojson, function(currentFeature, featureIndex) {
    if (featureIndex === 0 && initialValue === void 0)
      previousValue = currentFeature;
    else previousValue = callback(previousValue, currentFeature, featureIndex);
  });
  return previousValue;
}
function coordAll(geojson) {
  var coords = [];
  coordEach(geojson, function(coord) {
    coords.push(coord);
  });
  return coords;
}
function geomEach(geojson, callback) {
  var i, j, g, geometry, stopG, geometryMaybeCollection, isGeometryCollection, featureProperties, featureBBox, featureId, featureIndex = 0, isFeatureCollection = geojson.type === "FeatureCollection", isFeature = geojson.type === "Feature", stop = isFeatureCollection ? geojson.features.length : 1;
  for (i = 0; i < stop; i++) {
    geometryMaybeCollection = isFeatureCollection ? (
      // @ts-expect-error: Known type conflict
      geojson.features[i].geometry
    ) : isFeature ? (
      // @ts-expect-error: Known type conflict
      geojson.geometry
    ) : geojson;
    featureProperties = isFeatureCollection ? (
      // @ts-expect-error: Known type conflict
      geojson.features[i].properties
    ) : isFeature ? (
      // @ts-expect-error: Known type conflict
      geojson.properties
    ) : {};
    featureBBox = isFeatureCollection ? (
      // @ts-expect-error: Known type conflict
      geojson.features[i].bbox
    ) : isFeature ? (
      // @ts-expect-error: Known type conflict
      geojson.bbox
    ) : void 0;
    featureId = isFeatureCollection ? (
      // @ts-expect-error: Known type conflict
      geojson.features[i].id
    ) : isFeature ? (
      // @ts-expect-error: Known type conflict
      geojson.id
    ) : void 0;
    isGeometryCollection = geometryMaybeCollection ? geometryMaybeCollection.type === "GeometryCollection" : false;
    stopG = isGeometryCollection ? geometryMaybeCollection.geometries.length : 1;
    for (g = 0; g < stopG; g++) {
      geometry = isGeometryCollection ? geometryMaybeCollection.geometries[g] : geometryMaybeCollection;
      if (geometry === null) {
        if (
          // @ts-expect-error: Known type conflict
          callback(
            // @ts-expect-error: Known type conflict
            null,
            featureIndex,
            featureProperties,
            featureBBox,
            featureId
          ) === false
        )
          return false;
        continue;
      }
      switch (geometry.type) {
        case "Point":
        case "LineString":
        case "MultiPoint":
        case "Polygon":
        case "MultiLineString":
        case "MultiPolygon": {
          if (
            // @ts-expect-error: Known type conflict
            callback(
              geometry,
              featureIndex,
              featureProperties,
              featureBBox,
              featureId
            ) === false
          )
            return false;
          break;
        }
        case "GeometryCollection": {
          for (j = 0; j < geometry.geometries.length; j++) {
            if (
              // @ts-expect-error: Known type conflict
              callback(
                geometry.geometries[j],
                featureIndex,
                featureProperties,
                featureBBox,
                featureId
              ) === false
            )
              return false;
          }
          break;
        }
        default:
          throw new Error("Unknown Geometry Type");
      }
    }
    featureIndex++;
  }
}
function geomReduce(geojson, callback, initialValue) {
  var previousValue = initialValue;
  geomEach(
    geojson,
    function(currentGeometry, featureIndex, featureProperties, featureBBox, featureId) {
      if (featureIndex === 0 && initialValue === void 0)
        previousValue = currentGeometry;
      else
        previousValue = callback(
          // @ts-expect-error: Known type conflict
          previousValue,
          currentGeometry,
          featureIndex,
          featureProperties,
          featureBBox,
          featureId
        );
    }
  );
  return previousValue;
}
function flattenEach(geojson, callback) {
  geomEach(geojson, function(geometry, featureIndex, properties, bbox, id) {
    var type = geometry === null ? null : geometry.type;
    switch (type) {
      case null:
      case "Point":
      case "LineString":
      case "Polygon":
        if (
          // @ts-expect-error: Known type conflict
          callback(
            _helpers.feature.call(void 0, geometry, properties, { bbox, id }),
            featureIndex,
            0
          ) === false
        )
          return false;
        return;
    }
    var geomType;
    switch (type) {
      case "MultiPoint":
        geomType = "Point";
        break;
      case "MultiLineString":
        geomType = "LineString";
        break;
      case "MultiPolygon":
        geomType = "Polygon";
        break;
    }
    for (
      var multiFeatureIndex = 0;
      // @ts-expect-error: Known type conflict
      multiFeatureIndex < geometry.coordinates.length;
      multiFeatureIndex++
    ) {
      var coordinate = geometry.coordinates[multiFeatureIndex];
      var geom = {
        type: geomType,
        coordinates: coordinate
      };
      if (
        // @ts-expect-error: Known type conflict
        callback(_helpers.feature.call(void 0, geom, properties), featureIndex, multiFeatureIndex) === false
      )
        return false;
    }
  });
}
function flattenReduce(geojson, callback, initialValue) {
  var previousValue = initialValue;
  flattenEach(
    geojson,
    function(currentFeature, featureIndex, multiFeatureIndex) {
      if (featureIndex === 0 && multiFeatureIndex === 0 && initialValue === void 0)
        previousValue = currentFeature;
      else
        previousValue = callback(
          // @ts-expect-error: Known type conflict
          previousValue,
          currentFeature,
          featureIndex,
          multiFeatureIndex
        );
    }
  );
  return previousValue;
}
function segmentEach(geojson, callback) {
  flattenEach(geojson, function(feature2, featureIndex, multiFeatureIndex) {
    var segmentIndex = 0;
    if (!feature2.geometry) return;
    var type = feature2.geometry.type;
    if (type === "Point" || type === "MultiPoint") return;
    var previousCoords;
    var previousFeatureIndex = 0;
    var previousMultiIndex = 0;
    var prevGeomIndex = 0;
    if (
      // @ts-expect-error: Known type conflict
      coordEach(
        feature2,
        function(currentCoord, coordIndex, featureIndexCoord, multiPartIndexCoord, geometryIndex) {
          if (
            // @ts-expect-error: Known type conflict
            previousCoords === void 0 || featureIndex > previousFeatureIndex || multiPartIndexCoord > previousMultiIndex || geometryIndex > prevGeomIndex
          ) {
            previousCoords = currentCoord;
            previousFeatureIndex = featureIndex;
            previousMultiIndex = multiPartIndexCoord;
            prevGeomIndex = geometryIndex;
            segmentIndex = 0;
            return;
          }
          var currentSegment = _helpers.lineString.call(void 0, 
            // @ts-expect-error: Known type conflict
            [previousCoords, currentCoord],
            feature2.properties
          );
          if (
            // @ts-expect-error: Known type conflict
            callback(
              // @ts-expect-error: Known type conflict
              currentSegment,
              featureIndex,
              multiFeatureIndex,
              geometryIndex,
              segmentIndex
            ) === false
          )
            return false;
          segmentIndex++;
          previousCoords = currentCoord;
        }
      ) === false
    )
      return false;
  });
}
function segmentReduce(geojson, callback, initialValue) {
  var previousValue = initialValue;
  var started = false;
  segmentEach(
    geojson,
    function(currentSegment, featureIndex, multiFeatureIndex, geometryIndex, segmentIndex) {
      if (started === false && initialValue === void 0)
        previousValue = currentSegment;
      else
        previousValue = callback(
          previousValue,
          // @ts-expect-error: Known type conflict
          currentSegment,
          featureIndex,
          multiFeatureIndex,
          geometryIndex,
          segmentIndex
        );
      started = true;
    }
  );
  return previousValue;
}
function lineEach(geojson, callback) {
  if (!geojson) throw new Error("geojson is required");
  flattenEach(geojson, function(feature2, featureIndex, multiFeatureIndex) {
    if (feature2.geometry === null) return;
    var type = feature2.geometry.type;
    var coords = feature2.geometry.coordinates;
    switch (type) {
      case "LineString":
        if (callback(feature2, featureIndex, multiFeatureIndex, 0, 0) === false)
          return false;
        break;
      case "Polygon":
        for (var geometryIndex = 0; geometryIndex < coords.length; geometryIndex++) {
          if (
            // @ts-expect-error: Known type conflict
            callback(
              // @ts-expect-error: Known type conflict
              _helpers.lineString.call(void 0, coords[geometryIndex], feature2.properties),
              featureIndex,
              multiFeatureIndex,
              geometryIndex
            ) === false
          )
            return false;
        }
        break;
    }
  });
}
function lineReduce(geojson, callback, initialValue) {
  var previousValue = initialValue;
  lineEach(
    geojson,
    function(currentLine, featureIndex, multiFeatureIndex, geometryIndex) {
      if (featureIndex === 0 && initialValue === void 0)
        previousValue = currentLine;
      else
        previousValue = callback(
          previousValue,
          currentLine,
          featureIndex,
          multiFeatureIndex,
          geometryIndex
        );
    }
  );
  return previousValue;
}
function findSegment(geojson, options) {
  options = options || {};
  if (!_helpers.isObject.call(void 0, options)) throw new Error("options is invalid");
  var featureIndex = options.featureIndex || 0;
  var multiFeatureIndex = options.multiFeatureIndex || 0;
  var geometryIndex = options.geometryIndex || 0;
  var segmentIndex = options.segmentIndex || 0;
  var properties = options.properties;
  var geometry;
  switch (geojson.type) {
    case "FeatureCollection":
      if (featureIndex < 0)
        featureIndex = geojson.features.length + featureIndex;
      properties = properties || geojson.features[featureIndex].properties;
      geometry = geojson.features[featureIndex].geometry;
      break;
    case "Feature":
      properties = properties || geojson.properties;
      geometry = geojson.geometry;
      break;
    case "Point":
    case "MultiPoint":
      return null;
    case "LineString":
    case "Polygon":
    case "MultiLineString":
    case "MultiPolygon":
      geometry = geojson;
      break;
    default:
      throw new Error("geojson is invalid");
  }
  if (geometry === null) return null;
  var coords = geometry.coordinates;
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return null;
    case "LineString":
      if (segmentIndex < 0) segmentIndex = coords.length + segmentIndex - 1;
      return _helpers.lineString.call(void 0, 
        // @ts-expect-error: Known type conflict
        [coords[segmentIndex], coords[segmentIndex + 1]],
        properties,
        options
      );
    case "Polygon":
      if (geometryIndex < 0) geometryIndex = coords.length + geometryIndex;
      if (segmentIndex < 0)
        segmentIndex = coords[geometryIndex].length + segmentIndex - 1;
      return _helpers.lineString.call(void 0, 
        [
          // @ts-expect-error: Known type conflict
          coords[geometryIndex][segmentIndex],
          // @ts-expect-error: Known type conflict
          coords[geometryIndex][segmentIndex + 1]
        ],
        properties,
        options
      );
    case "MultiLineString":
      if (multiFeatureIndex < 0)
        multiFeatureIndex = coords.length + multiFeatureIndex;
      if (segmentIndex < 0)
        segmentIndex = coords[multiFeatureIndex].length + segmentIndex - 1;
      return _helpers.lineString.call(void 0, 
        [
          // @ts-expect-error: Known type conflict
          coords[multiFeatureIndex][segmentIndex],
          // @ts-expect-error: Known type conflict
          coords[multiFeatureIndex][segmentIndex + 1]
        ],
        properties,
        options
      );
    case "MultiPolygon":
      if (multiFeatureIndex < 0)
        multiFeatureIndex = coords.length + multiFeatureIndex;
      if (geometryIndex < 0)
        geometryIndex = coords[multiFeatureIndex].length + geometryIndex;
      if (segmentIndex < 0)
        segmentIndex = // @ts-expect-error: Known type conflict
        coords[multiFeatureIndex][geometryIndex].length - segmentIndex - 1;
      return _helpers.lineString.call(void 0, 
        [
          // @ts-expect-error: Known type conflict
          coords[multiFeatureIndex][geometryIndex][segmentIndex],
          // @ts-expect-error: Known type conflict
          coords[multiFeatureIndex][geometryIndex][segmentIndex + 1]
        ],
        properties,
        options
      );
  }
  throw new Error("geojson is invalid");
}
function findPoint(geojson, options) {
  options = options || {};
  if (!_helpers.isObject.call(void 0, options)) throw new Error("options is invalid");
  var featureIndex = options.featureIndex || 0;
  var multiFeatureIndex = options.multiFeatureIndex || 0;
  var geometryIndex = options.geometryIndex || 0;
  var coordIndex = options.coordIndex || 0;
  var properties = options.properties;
  var geometry;
  switch (geojson.type) {
    case "FeatureCollection":
      if (featureIndex < 0)
        featureIndex = geojson.features.length + featureIndex;
      properties = properties || geojson.features[featureIndex].properties;
      geometry = geojson.features[featureIndex].geometry;
      break;
    case "Feature":
      properties = properties || geojson.properties;
      geometry = geojson.geometry;
      break;
    case "Point":
    case "MultiPoint":
      return null;
    case "LineString":
    case "Polygon":
    case "MultiLineString":
    case "MultiPolygon":
      geometry = geojson;
      break;
    default:
      throw new Error("geojson is invalid");
  }
  if (geometry === null) return null;
  var coords = geometry.coordinates;
  switch (geometry.type) {
    case "Point":
      return _helpers.point.call(void 0, coords, properties, options);
    case "MultiPoint":
      if (multiFeatureIndex < 0)
        multiFeatureIndex = coords.length + multiFeatureIndex;
      return _helpers.point.call(void 0, coords[multiFeatureIndex], properties, options);
    case "LineString":
      if (coordIndex < 0) coordIndex = coords.length + coordIndex;
      return _helpers.point.call(void 0, coords[coordIndex], properties, options);
    case "Polygon":
      if (geometryIndex < 0) geometryIndex = coords.length + geometryIndex;
      if (coordIndex < 0)
        coordIndex = coords[geometryIndex].length + coordIndex;
      return _helpers.point.call(void 0, coords[geometryIndex][coordIndex], properties, options);
    case "MultiLineString":
      if (multiFeatureIndex < 0)
        multiFeatureIndex = coords.length + multiFeatureIndex;
      if (coordIndex < 0)
        coordIndex = coords[multiFeatureIndex].length + coordIndex;
      return _helpers.point.call(void 0, coords[multiFeatureIndex][coordIndex], properties, options);
    case "MultiPolygon":
      if (multiFeatureIndex < 0)
        multiFeatureIndex = coords.length + multiFeatureIndex;
      if (geometryIndex < 0)
        geometryIndex = coords[multiFeatureIndex].length + geometryIndex;
      if (coordIndex < 0)
        coordIndex = coords[multiFeatureIndex][geometryIndex].length - coordIndex;
      return _helpers.point.call(void 0, 
        coords[multiFeatureIndex][geometryIndex][coordIndex],
        properties,
        options
      );
  }
  throw new Error("geojson is invalid");
}


















exports.coordAll = coordAll; exports.coordEach = coordEach; exports.coordReduce = coordReduce; exports.featureEach = featureEach; exports.featureReduce = featureReduce; exports.findPoint = findPoint; exports.findSegment = findSegment; exports.flattenEach = flattenEach; exports.flattenReduce = flattenReduce; exports.geomEach = geomEach; exports.geomReduce = geomReduce; exports.lineEach = lineEach; exports.lineReduce = lineReduce; exports.propEach = propEach; exports.propReduce = propReduce; exports.segmentEach = segmentEach; exports.segmentReduce = segmentReduce;

},{"@turf/helpers":1}],5:[function(require,module,exports){
/*!
 * arr-flatten <https://github.com/jonschlinkert/arr-flatten>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */

'use strict';

module.exports = function (arr) {
  return flat(arr, []);
};

function flat(arr, res) {
  var i = 0, cur;
  var len = arr.length;
  for (; i < len; i++) {
    cur = arr[i];
    Array.isArray(cur) ? flat(cur, res) : res.push(cur);
  }
  return res;
}

},{}],6:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  var i
  for (i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],7:[function(require,module,exports){
module.exports = require('./lib/bezier');

},{"./lib/bezier":8}],8:[function(require,module,exports){
/**
  A javascript Bezier curve library by Pomax.

  Based on http://pomax.github.io/bezierinfo

  This code is MIT licensed.
**/
(function() {
  "use strict";

  // math-inlining.
  var abs = Math.abs,
    min = Math.min,
    max = Math.max,
    cos = Math.cos,
    sin = Math.sin,
    acos = Math.acos,
    sqrt = Math.sqrt,
    pi = Math.PI,
    // a zero coordinate, which is surprisingly useful
    ZERO = { x: 0, y: 0, z: 0 };

  // quite needed
  var utils = require("./utils.js");

  // only used for outlines atm.
  var PolyBezier = require("./poly-bezier.js");

  /**
   * Bezier curve constructor. The constructor argument can be one of three things:
   *
   * 1. array/4 of {x:..., y:..., z:...}, z optional
   * 2. numerical array/8 ordered x1,y1,x2,y2,x3,y3,x4,y4
   * 3. numerical array/12 ordered x1,y1,z1,x2,y2,z2,x3,y3,z3,x4,y4,z4
   *
   */
  var Bezier = function(coords) {
    var args = coords && coords.forEach ? coords : [].slice.call(arguments);
    var coordlen = false;
    if (typeof args[0] === "object") {
      coordlen = args.length;
      var newargs = [];
      args.forEach(function(point) {
        ["x", "y", "z"].forEach(function(d) {
          if (typeof point[d] !== "undefined") {
            newargs.push(point[d]);
          }
        });
      });
      args = newargs;
    }
    var higher = false;
    var len = args.length;
    if (coordlen) {
      if (coordlen > 4) {
        if (arguments.length !== 1) {
          throw new Error(
            "Only new Bezier(point[]) is accepted for 4th and higher order curves"
          );
        }
        higher = true;
      }
    } else {
      if (len !== 6 && len !== 8 && len !== 9 && len !== 12) {
        if (arguments.length !== 1) {
          throw new Error(
            "Only new Bezier(point[]) is accepted for 4th and higher order curves"
          );
        }
      }
    }
    var _3d =
      (!higher && (len === 9 || len === 12)) ||
      (coords && coords[0] && typeof coords[0].z !== "undefined");
    this._3d = _3d;
    var points = [];
    for (var idx = 0, step = _3d ? 3 : 2; idx < len; idx += step) {
      var point = {
        x: args[idx],
        y: args[idx + 1]
      };
      if (_3d) {
        point.z = args[idx + 2];
      }
      points.push(point);
    }
    this.order = points.length - 1;
    this.points = points;
    var dims = ["x", "y"];
    if (_3d) dims.push("z");
    this.dims = dims;
    this.dimlen = dims.length;

    (function(curve) {
      var order = curve.order;
      var points = curve.points;
      var a = utils.align(points, { p1: points[0], p2: points[order] });
      for (var i = 0; i < a.length; i++) {
        if (abs(a[i].y) > 0.0001) {
          curve._linear = false;
          return;
        }
      }
      curve._linear = true;
    })(this);

    this._t1 = 0;
    this._t2 = 1;
    this.update();
  };

  var svgToBeziers = require("./svg-to-beziers");

  /**
   * turn an svg <path> d attribute into a sequence of Bezier segments.
   */
  Bezier.SVGtoBeziers = function(d) {
    return svgToBeziers(Bezier, d);
  };

  function getABC(n, S, B, E, t) {
    if (typeof t === "undefined") {
      t = 0.5;
    }
    var u = utils.projectionratio(t, n),
      um = 1 - u,
      C = {
        x: u * S.x + um * E.x,
        y: u * S.y + um * E.y
      },
      s = utils.abcratio(t, n),
      A = {
        x: B.x + (B.x - C.x) / s,
        y: B.y + (B.y - C.y) / s
      };
    return { A: A, B: B, C: C };
  }

  Bezier.quadraticFromPoints = function(p1, p2, p3, t) {
    if (typeof t === "undefined") {
      t = 0.5;
    }
    // shortcuts, although they're really dumb
    if (t === 0) {
      return new Bezier(p2, p2, p3);
    }
    if (t === 1) {
      return new Bezier(p1, p2, p2);
    }
    // real fitting.
    var abc = getABC(2, p1, p2, p3, t);
    return new Bezier(p1, abc.A, p3);
  };

  Bezier.cubicFromPoints = function(S, B, E, t, d1) {
    if (typeof t === "undefined") {
      t = 0.5;
    }
    var abc = getABC(3, S, B, E, t);
    if (typeof d1 === "undefined") {
      d1 = utils.dist(B, abc.C);
    }
    var d2 = d1 * (1 - t) / t;

    var selen = utils.dist(S, E),
      lx = (E.x - S.x) / selen,
      ly = (E.y - S.y) / selen,
      bx1 = d1 * lx,
      by1 = d1 * ly,
      bx2 = d2 * lx,
      by2 = d2 * ly;
    // derivation of new hull coordinates
    var e1 = { x: B.x - bx1, y: B.y - by1 },
      e2 = { x: B.x + bx2, y: B.y + by2 },
      A = abc.A,
      v1 = { x: A.x + (e1.x - A.x) / (1 - t), y: A.y + (e1.y - A.y) / (1 - t) },
      v2 = { x: A.x + (e2.x - A.x) / t, y: A.y + (e2.y - A.y) / t },
      nc1 = { x: S.x + (v1.x - S.x) / t, y: S.y + (v1.y - S.y) / t },
      nc2 = {
        x: E.x + (v2.x - E.x) / (1 - t),
        y: E.y + (v2.y - E.y) / (1 - t)
      };
    // ...done
    return new Bezier(S, nc1, nc2, E);
  };

  var getUtils = function() {
    return utils;
  };

  Bezier.getUtils = getUtils;

  Bezier.PolyBezier = PolyBezier;

  Bezier.prototype = {
    getUtils: getUtils,
    valueOf: function() {
      return this.toString();
    },
    toString: function() {
      return utils.pointsToString(this.points);
    },
    toSVG: function(relative) {
      if (this._3d) return false;
      var p = this.points,
        x = p[0].x,
        y = p[0].y,
        s = ["M", x, y, this.order === 2 ? "Q" : "C"];
      for (var i = 1, last = p.length; i < last; i++) {
        s.push(p[i].x);
        s.push(p[i].y);
      }
      return s.join(" ");
    },
    setRatios: function(ratios) {
      if (ratios.length !== this.points.length) {
        throw new Error("incorrect number of ratio values");
      }
      this.ratios = ratios;
      this._lut = []; //  invalidate any precomputed LUT
    },
    verify: function() {
      var print = this.coordDigest();
      if (print !== this._print) {
        this._print = print;
        this.update();
      }
    },
    coordDigest: function() {
      return this.points.map(function(c,pos) {
        return '' + pos + c.x + c.y + (c.z?c.z:0);
      }).join('');
    },
    update: function(newprint) {
      // invalidate any precomputed LUT
      this._lut = [];
      this.dpoints = utils.derive(this.points, this._3d);
      this.computedirection();
    },
    computedirection: function() {
      var points = this.points;
      var angle = utils.angle(points[0], points[this.order], points[1]);
      this.clockwise = angle > 0;
    },
    length: function() {
      return utils.length(this.derivative.bind(this));
    },
    _lut: [],
    getLUT: function(steps) {
      this.verify();
      steps = steps || 100;
      if (this._lut.length === steps) {
        return this._lut;
      }
      this._lut = [];
      // We want a range from 0 to 1 inclusive, so
      // we decrement and then use <= rather than <:
      steps--;
      for (var t = 0; t <= steps; t++) {
        this._lut.push(this.compute(t / steps));
      }
      return this._lut;
    },
    on: function(point, error) {
      error = error || 5;
      var lut = this.getLUT(),
        hits = [],
        c,
        t = 0;
      for (var i = 0; i < lut.length; i++) {
        c = lut[i];
        if (utils.dist(c, point) < error) {
          hits.push(c);
          t += i / lut.length;
        }
      }
      if (!hits.length) return false;
      return (t /= hits.length);
    },
    project: function(point) {
      // step 1: coarse check
      var LUT = this.getLUT(),
        l = LUT.length - 1,
        closest = utils.closest(LUT, point),
        mdist = closest.mdist,
        mpos = closest.mpos;

      // step 2: fine check
      var ft,
        t,
        p,
        d,
        t1 = (mpos - 1) / l,
        t2 = (mpos + 1) / l,
        step = 0.1 / l;
      mdist += 1;
      for (t = t1, ft = t; t < t2 + step; t += step) {
        p = this.compute(t);
        d = utils.dist(point, p);
        if (d < mdist) {
          mdist = d;
          ft = t;
        }
      }
      p = this.compute(ft);
      p.t = ft;
      p.d = mdist;
      return p;
    },
    get: function(t) {
      return this.compute(t);
    },
    point: function(idx) {
      return this.points[idx];
    },
    compute: function(t) {
      if (this.ratios) return utils.computeWithRatios(t, this.points, this.ratios, this._3d);
      return utils.compute(t, this.points, this._3d, this.ratios);
    },
    raise: function() {
      var p = this.points,
        np = [p[0]],
        i,
        k = p.length,
        pi,
        pim;
      for (var i = 1; i < k; i++) {
        pi = p[i];
        pim = p[i - 1];
        np[i] = {
          x: (k - i) / k * pi.x + i / k * pim.x,
          y: (k - i) / k * pi.y + i / k * pim.y
        };
      }
      np[k] = p[k - 1];
      return new Bezier(np);
    },
    derivative: function(t) {
      var mt = 1 - t,
        a,
        b,
        c = 0,
        p = this.dpoints[0];
      if (this.order === 2) {
        p = [p[0], p[1], ZERO];
        a = mt;
        b = t;
      }
      if (this.order === 3) {
        a = mt * mt;
        b = mt * t * 2;
        c = t * t;
      }
      var ret = {
        x: a * p[0].x + b * p[1].x + c * p[2].x,
        y: a * p[0].y + b * p[1].y + c * p[2].y
      };
      if (this._3d) {
        ret.z = a * p[0].z + b * p[1].z + c * p[2].z;
      }
      return ret;
    },
    curvature: function(t) {
      return utils.curvature(t, this.points, this._3d);
    },
    inflections: function() {
      return utils.inflections(this.points);
    },
    normal: function(t) {
      return this._3d ? this.__normal3(t) : this.__normal2(t);
    },
    __normal2: function(t) {
      var d = this.derivative(t);
      var q = sqrt(d.x * d.x + d.y * d.y);
      return { x: -d.y / q, y: d.x / q };
    },
    __normal3: function(t) {
      // see http://stackoverflow.com/questions/25453159
      var r1 = this.derivative(t),
        r2 = this.derivative(t + 0.01),
        q1 = sqrt(r1.x * r1.x + r1.y * r1.y + r1.z * r1.z),
        q2 = sqrt(r2.x * r2.x + r2.y * r2.y + r2.z * r2.z);
      r1.x /= q1;
      r1.y /= q1;
      r1.z /= q1;
      r2.x /= q2;
      r2.y /= q2;
      r2.z /= q2;
      // cross product
      var c = {
        x: r2.y * r1.z - r2.z * r1.y,
        y: r2.z * r1.x - r2.x * r1.z,
        z: r2.x * r1.y - r2.y * r1.x
      };
      var m = sqrt(c.x * c.x + c.y * c.y + c.z * c.z);
      c.x /= m;
      c.y /= m;
      c.z /= m;
      // rotation matrix
      var R = [
        c.x * c.x,
        c.x * c.y - c.z,
        c.x * c.z + c.y,
        c.x * c.y + c.z,
        c.y * c.y,
        c.y * c.z - c.x,
        c.x * c.z - c.y,
        c.y * c.z + c.x,
        c.z * c.z
      ];
      // normal vector:
      var n = {
        x: R[0] * r1.x + R[1] * r1.y + R[2] * r1.z,
        y: R[3] * r1.x + R[4] * r1.y + R[5] * r1.z,
        z: R[6] * r1.x + R[7] * r1.y + R[8] * r1.z
      };
      return n;
    },
    hull: function(t) {
      var p = this.points,
        _p = [],
        pt,
        q = [],
        idx = 0,
        i = 0,
        l = 0;
      q[idx++] = p[0];
      q[idx++] = p[1];
      q[idx++] = p[2];
      if (this.order === 3) {
        q[idx++] = p[3];
      }
      // we lerp between all points at each iteration, until we have 1 point left.
      while (p.length > 1) {
        _p = [];
        for (i = 0, l = p.length - 1; i < l; i++) {
          pt = utils.lerp(t, p[i], p[i + 1]);
          q[idx++] = pt;
          _p.push(pt);
        }
        p = _p;
      }
      return q;
    },
    split: function(t1, t2) {
      // shortcuts
      if (t1 === 0 && !!t2) {
        return this.split(t2).left;
      }
      if (t2 === 1) {
        return this.split(t1).right;
      }

      // no shortcut: use "de Casteljau" iteration.
      var q = this.hull(t1);
      var result = {
        left:
          this.order === 2
            ? new Bezier([q[0], q[3], q[5]])
            : new Bezier([q[0], q[4], q[7], q[9]]),
        right:
          this.order === 2
            ? new Bezier([q[5], q[4], q[2]])
            : new Bezier([q[9], q[8], q[6], q[3]]),
        span: q
      };

      // make sure we bind _t1/_t2 information!
      result.left._t1 = utils.map(0, 0, 1, this._t1, this._t2);
      result.left._t2 = utils.map(t1, 0, 1, this._t1, this._t2);
      result.right._t1 = utils.map(t1, 0, 1, this._t1, this._t2);
      result.right._t2 = utils.map(1, 0, 1, this._t1, this._t2);

      // if we have no t2, we're done
      if (!t2) {
        return result;
      }

      // if we have a t2, split again:
      t2 = utils.map(t2, t1, 1, 0, 1);
      var subsplit = result.right.split(t2);
      return subsplit.left;
    },
    extrema: function() {
      var dims = this.dims,
        result = {},
        roots = [],
        p,
        mfn;
      dims.forEach(
        function(dim) {
          mfn = function(v) {
            return v[dim];
          };
          p = this.dpoints[0].map(mfn);
          result[dim] = utils.droots(p);
          if (this.order === 3) {
            p = this.dpoints[1].map(mfn);
            result[dim] = result[dim].concat(utils.droots(p));
          }
          result[dim] = result[dim].filter(function(t) {
            return t >= 0 && t <= 1;
          });
          roots = roots.concat(result[dim].sort(utils.numberSort));
        }.bind(this)
      );
      roots = roots.sort(utils.numberSort).filter(function(v, idx) {
        return roots.indexOf(v) === idx;
      });
      result.values = roots;
      return result;
    },
    bbox: function() {
      var extrema = this.extrema(),
        result = {};
      this.dims.forEach(
        function(d) {
          result[d] = utils.getminmax(this, d, extrema[d]);
        }.bind(this)
      );
      return result;
    },
    overlaps: function(curve) {
      var lbbox = this.bbox(),
        tbbox = curve.bbox();
      return utils.bboxoverlap(lbbox, tbbox);
    },
    offset: function(t, d) {
      if (typeof d !== "undefined") {
        var c = this.get(t);
        var n = this.normal(t);
        var ret = {
          c: c,
          n: n,
          x: c.x + n.x * d,
          y: c.y + n.y * d
        };
        if (this._3d) {
          ret.z = c.z + n.z * d;
        }
        return ret;
      }
      if (this._linear) {
        var nv = this.normal(0);
        var coords = this.points.map(function(p) {
          var ret = {
            x: p.x + t * nv.x,
            y: p.y + t * nv.y
          };
          if (p.z && n.z) {
            ret.z = p.z + t * nv.z;
          }
          return ret;
        });
        return [new Bezier(coords)];
      }
      var reduced = this.reduce();
      return reduced.map(function(s) {
        if (s._linear) {
          return s.offset(t)[0];
        }
        return s.scale(t);
      });
    },
    simple: function() {
      if (this.order === 3) {
        var a1 = utils.angle(this.points[0], this.points[3], this.points[1]);
        var a2 = utils.angle(this.points[0], this.points[3], this.points[2]);
        if ((a1 > 0 && a2 < 0) || (a1 < 0 && a2 > 0)) return false;
      }
      var n1 = this.normal(0);
      var n2 = this.normal(1);
      var s = n1.x * n2.x + n1.y * n2.y;
      if (this._3d) {
        s += n1.z * n2.z;
      }
      var angle = abs(acos(s));
      return angle < pi / 3;
    },
    reduce: function() {
      var i,
        t1 = 0,
        t2 = 0,
        step = 0.01,
        segment,
        pass1 = [],
        pass2 = [];
      // first pass: split on extrema
      var extrema = this.extrema().values;
      if (extrema.indexOf(0) === -1) {
        extrema = [0].concat(extrema);
      }
      if (extrema.indexOf(1) === -1) {
        extrema.push(1);
      }

      for (t1 = extrema[0], i = 1; i < extrema.length; i++) {
        t2 = extrema[i];
        segment = this.split(t1, t2);
        segment._t1 = t1;
        segment._t2 = t2;
        pass1.push(segment);
        t1 = t2;
      }

      // second pass: further reduce these segments to simple segments
      pass1.forEach(function(p1) {
        t1 = 0;
        t2 = 0;
        while (t2 <= 1) {
          for (t2 = t1 + step; t2 <= 1 + step; t2 += step) {
            segment = p1.split(t1, t2);
            if (!segment.simple()) {
              t2 -= step;
              if (abs(t1 - t2) < step) {
                // we can never form a reduction
                return [];
              }
              segment = p1.split(t1, t2);
              segment._t1 = utils.map(t1, 0, 1, p1._t1, p1._t2);
              segment._t2 = utils.map(t2, 0, 1, p1._t1, p1._t2);
              pass2.push(segment);
              t1 = t2;
              break;
            }
          }
        }
        if (t1 < 1) {
          segment = p1.split(t1, 1);
          segment._t1 = utils.map(t1, 0, 1, p1._t1, p1._t2);
          segment._t2 = p1._t2;
          pass2.push(segment);
        }
      });
      return pass2;
    },
    scale: function(d) {
      var order = this.order;
      var distanceFn = false;
      if (typeof d === "function") {
        distanceFn = d;
      }
      if (distanceFn && order === 2) {
        return this.raise().scale(distanceFn);
      }

      // TODO: add special handling for degenerate (=linear) curves.
      var clockwise = this.clockwise;
      var r1 = distanceFn ? distanceFn(0) : d;
      var r2 = distanceFn ? distanceFn(1) : d;
      var v = [this.offset(0, 10), this.offset(1, 10)];
      var o = utils.lli4(v[0], v[0].c, v[1], v[1].c);
      if (!o) {
        throw new Error("cannot scale this curve. Try reducing it first.");
      }
      // move all points by distance 'd' wrt the origin 'o'
      var points = this.points,
        np = [];

      // move end points by fixed distance along normal.
      [0, 1].forEach(
        function(t) {
          var p = (np[t * order] = utils.copy(points[t * order]));
          p.x += (t ? r2 : r1) * v[t].n.x;
          p.y += (t ? r2 : r1) * v[t].n.y;
        }.bind(this)
      );

      if (!distanceFn) {
        // move control points to lie on the intersection of the offset
        // derivative vector, and the origin-through-control vector
        [0, 1].forEach(
          function(t) {
            if (this.order === 2 && !!t) return;
            var p = np[t * order];
            var d = this.derivative(t);
            var p2 = { x: p.x + d.x, y: p.y + d.y };
            np[t + 1] = utils.lli4(p, p2, o, points[t + 1]);
          }.bind(this)
        );
        return new Bezier(np);
      }

      // move control points by "however much necessary to
      // ensure the correct tangent to endpoint".
      [0, 1].forEach(
        function(t) {
          if (this.order === 2 && !!t) return;
          var p = points[t + 1];
          var ov = {
            x: p.x - o.x,
            y: p.y - o.y
          };
          var rc = distanceFn ? distanceFn((t + 1) / order) : d;
          if (distanceFn && !clockwise) rc = -rc;
          var m = sqrt(ov.x * ov.x + ov.y * ov.y);
          ov.x /= m;
          ov.y /= m;
          np[t + 1] = {
            x: p.x + rc * ov.x,
            y: p.y + rc * ov.y
          };
        }.bind(this)
      );
      return new Bezier(np);
    },
    outline: function(d1, d2, d3, d4) {
      d2 = typeof d2 === "undefined" ? d1 : d2;
      var reduced = this.reduce(),
        len = reduced.length,
        fcurves = [],
        bcurves = [],
        p,
        alen = 0,
        tlen = this.length();

      var graduated = typeof d3 !== "undefined" && typeof d4 !== "undefined";

      function linearDistanceFunction(s, e, tlen, alen, slen) {
        return function(v) {
          var f1 = alen / tlen,
            f2 = (alen + slen) / tlen,
            d = e - s;
          return utils.map(v, 0, 1, s + f1 * d, s + f2 * d);
        };
      }

      // form curve oulines
      reduced.forEach(function(segment) {
        slen = segment.length();
        if (graduated) {
          fcurves.push(
            segment.scale(linearDistanceFunction(d1, d3, tlen, alen, slen))
          );
          bcurves.push(
            segment.scale(linearDistanceFunction(-d2, -d4, tlen, alen, slen))
          );
        } else {
          fcurves.push(segment.scale(d1));
          bcurves.push(segment.scale(-d2));
        }
        alen += slen;
      });

      // reverse the "return" outline
      bcurves = bcurves
        .map(function(s) {
          p = s.points;
          if (p[3]) {
            s.points = [p[3], p[2], p[1], p[0]];
          } else {
            s.points = [p[2], p[1], p[0]];
          }
          return s;
        })
        .reverse();

      // form the endcaps as lines
      var fs = fcurves[0].points[0],
        fe = fcurves[len - 1].points[fcurves[len - 1].points.length - 1],
        bs = bcurves[len - 1].points[bcurves[len - 1].points.length - 1],
        be = bcurves[0].points[0],
        ls = utils.makeline(bs, fs),
        le = utils.makeline(fe, be),
        segments = [ls]
          .concat(fcurves)
          .concat([le])
          .concat(bcurves),
        slen = segments.length;

      return new PolyBezier(segments);
    },
    outlineshapes: function(d1, d2, curveIntersectionThreshold) {
      d2 = d2 || d1;
      var outline = this.outline(d1, d2).curves;
      var shapes = [];
      for (var i = 1, len = outline.length; i < len / 2; i++) {
        var shape = utils.makeshape(
          outline[i],
          outline[len - i],
          curveIntersectionThreshold
        );
        shape.startcap.virtual = i > 1;
        shape.endcap.virtual = i < len / 2 - 1;
        shapes.push(shape);
      }
      return shapes;
    },
    intersects: function(curve, curveIntersectionThreshold) {
      if (!curve) return this.selfintersects(curveIntersectionThreshold);
      if (curve.p1 && curve.p2) {
        return this.lineIntersects(curve);
      }
      if (curve instanceof Bezier) {
        curve = curve.reduce();
      }
      return this.curveintersects(
        this.reduce(),
        curve,
        curveIntersectionThreshold
      );
    },
    lineIntersects: function(line) {
      var mx = min(line.p1.x, line.p2.x),
        my = min(line.p1.y, line.p2.y),
        MX = max(line.p1.x, line.p2.x),
        MY = max(line.p1.y, line.p2.y),
        self = this;
      return utils.roots(this.points, line).filter(function(t) {
        var p = self.get(t);
        return utils.between(p.x, mx, MX) && utils.between(p.y, my, MY);
      });
    },
    selfintersects: function(curveIntersectionThreshold) {
      var reduced = this.reduce();
      // "simple" curves cannot intersect with their direct
      // neighbour, so for each segment X we check whether
      // it intersects [0:x-2][x+2:last].
      var i,
        len = reduced.length - 2,
        results = [],
        result,
        left,
        right;
      for (i = 0; i < len; i++) {
        left = reduced.slice(i, i + 1);
        right = reduced.slice(i + 2);
        result = this.curveintersects(left, right, curveIntersectionThreshold);
        results = results.concat(result);
      }
      return results;
    },
    curveintersects: function(c1, c2, curveIntersectionThreshold) {
      var pairs = [];
      // step 1: pair off any overlapping segments
      c1.forEach(function(l) {
        c2.forEach(function(r) {
          if (l.overlaps(r)) {
            pairs.push({ left: l, right: r });
          }
        });
      });
      // step 2: for each pairing, run through the convergence algorithm.
      var intersections = [];
      pairs.forEach(function(pair) {
        var result = utils.pairiteration(
          pair.left,
          pair.right,
          curveIntersectionThreshold
        );
        if (result.length > 0) {
          intersections = intersections.concat(result);
        }
      });
      return intersections;
    },
    arcs: function(errorThreshold) {
      errorThreshold = errorThreshold || 0.5;
      var circles = [];
      return this._iterate(errorThreshold, circles);
    },
    _error: function(pc, np1, s, e) {
      var q = (e - s) / 4,
        c1 = this.get(s + q),
        c2 = this.get(e - q),
        ref = utils.dist(pc, np1),
        d1 = utils.dist(pc, c1),
        d2 = utils.dist(pc, c2);
      return abs(d1 - ref) + abs(d2 - ref);
    },
    _iterate: function(errorThreshold, circles) {
      var t_s = 0,
        t_e = 1,
        safety;
      // we do a binary search to find the "good `t` closest to no-longer-good"
      do {
        safety = 0;

        // step 1: start with the maximum possible arc
        t_e = 1;

        // points:
        var np1 = this.get(t_s),
          np2,
          np3,
          arc,
          prev_arc;

        // booleans:
        var curr_good = false,
          prev_good = false,
          done;

        // numbers:
        var t_m = t_e,
          prev_e = 1,
          step = 0;

        // step 2: find the best possible arc
        do {
          prev_good = curr_good;
          prev_arc = arc;
          t_m = (t_s + t_e) / 2;
          step++;

          np2 = this.get(t_m);
          np3 = this.get(t_e);

          arc = utils.getccenter(np1, np2, np3);

          //also save the t values
          arc.interval = {
            start: t_s,
            end: t_e
          };

          var error = this._error(arc, np1, t_s, t_e);
          curr_good = error <= errorThreshold;

          done = prev_good && !curr_good;
          if (!done) prev_e = t_e;

          // this arc is fine: we can move 'e' up to see if we can find a wider arc
          if (curr_good) {
            // if e is already at max, then we're done for this arc.
            if (t_e >= 1) {
              // make sure we cap at t=1
              arc.interval.end = prev_e = 1;
              prev_arc = arc;
              // if we capped the arc segment to t=1 we also need to make sure that
              // the arc's end angle is correct with respect to the bezier end point.
              if (t_e > 1) {
                var d = {
                  x: arc.x + arc.r * cos(arc.e),
                  y: arc.y + arc.r * sin(arc.e)
                };
                arc.e += utils.angle({ x: arc.x, y: arc.y }, d, this.get(1));
              }
              break;
            }
            // if not, move it up by half the iteration distance
            t_e = t_e + (t_e - t_s) / 2;
          } else {
            // this is a bad arc: we need to move 'e' down to find a good arc
            t_e = t_m;
          }
        } while (!done && safety++ < 100);

        if (safety >= 100) {
          break;
        }

        // console.log("L835: [F] arc found", t_s, prev_e, prev_arc.x, prev_arc.y, prev_arc.s, prev_arc.e);

        prev_arc = prev_arc ? prev_arc : arc;
        circles.push(prev_arc);
        t_s = prev_e;
      } while (t_e < 1);
      return circles;
    }
  };

  module.exports = Bezier;
})();

},{"./poly-bezier.js":10,"./svg-to-beziers":11,"./utils.js":12}],9:[function(require,module,exports){
/**
 * Normalise an SVG path to absolute coordinates
 * and full commands, rather than relative coordinates
 * and/or shortcut commands.
 */
function normalizePath(d) {
  // preprocess "d" so that we have spaces between values
  d = d
    .replace(/,/g, " ") // replace commas with spaces
    .replace(/-/g, " - ") // add spacing around minus signs
    .replace(/-\s+/g, "-") // remove spacing to the right of minus signs.
    .replace(/([a-zA-Z])/g, " $1 ");

  // set up the variables used in this function
  var instructions = d.replace(/([a-zA-Z])\s?/g, "|$1").split("|"),
    instructionLength = instructions.length,
    i,
    instruction,
    op,
    lop,
    args = [],
    alen,
    a,
    sx = 0,
    sy = 0,
    x = 0,
    y = 0,
    cx = 0,
    cy = 0,
    cx2 = 0,
    cy2 = 0,
    normalized = "";

  // we run through the instruction list starting at 1, not 0,
  // because we split up "|M x y ...." so the first element will
  // always be an empty string. By design.
  for (i = 1; i < instructionLength; i++) {
    // which instruction is this?
    instruction = instructions[i];
    op = instruction.substring(0, 1);
    lop = op.toLowerCase();

    // what are the arguments? note that we need to convert
    // all strings into numbers, or + will do silly things.
    args = instruction
      .replace(op, "")
      .trim()
      .split(" ");
    args = args
      .filter(function(v) {
        return v !== "";
      })
      .map(parseFloat);
    alen = args.length;

    // we could use a switch, but elaborate code in a "case" with
    // fallthrough is just horrid to read. So let's use ifthen
    // statements instead.

    // moveto command (plus possible lineto)
    if (lop === "m") {
      normalized += "M ";
      if (op === "m") {
        x += args[0];
        y += args[1];
      } else {
        x = args[0];
        y = args[1];
      }
      // records start position, for dealing
      // with the shape close operator ('Z')
      sx = x;
      sy = y;
      normalized += x + " " + y + " ";
      if (alen > 2) {
        for (a = 0; a < alen; a += 2) {
          if (op === "m") {
            x += args[a];
            y += args[a + 1];
          } else {
            x = args[a];
            y = args[a + 1];
          }
          normalized += ["L",x,y,''].join(" ");
        }
      }
    } else if (lop === "l") {
      // lineto commands
      for (a = 0; a < alen; a += 2) {
        if (op === "l") {
          x += args[a];
          y += args[a + 1];
        } else {
          x = args[a];
          y = args[a + 1];
        }
        normalized += ["L",x,y,''].join(" ");
      }
    } else if (lop === "h") {
      for (a = 0; a < alen; a++) {
        if (op === "h") {
          x += args[a];
        } else {
          x = args[a];
        }
        normalized += ["L",x,y,''].join(" ");
      }
    } else if (lop === "v") {
      for (a = 0; a < alen; a++) {
        if (op === "v") {
          y += args[a];
        } else {
          y = args[a];
        }
        normalized += ["L",x,y,''].join(" ");
      }
    } else if (lop === "q") {
      // quadratic curveto commands
      for (a = 0; a < alen; a += 4) {
        if (op === "q") {
          cx = x + args[a];
          cy = y + args[a + 1];
          x += args[a + 2];
          y += args[a + 3];
        } else {
          cx = args[a];
          cy = args[a + 1];
          x = args[a + 2];
          y = args[a + 3];
        }
        normalized += ["Q",cx,cy,x,y,''].join(" ");
      }
    } else if (lop === "t") {
      for (a = 0; a < alen; a += 2) {
        // reflect previous cx/cy over x/y
        cx = x + (x - cx);
        cy = y + (y - cy);
        // then get real end point
        if (op === "t") {
          x += args[a];
          y += args[a + 1];
        } else {
          x = args[a];
          y = args[a + 1];
        }
        normalized += ["Q",cx,cy,x,y,''].join(" ");
      }
    } else if (lop === "c") {
      // cubic curveto commands
      for (a = 0; a < alen; a += 6) {
        if (op === "c") {
          cx = x + args[a];
          cy = y + args[a + 1];
          cx2 = x + args[a + 2];
          cy2 = y + args[a + 3];
          x += args[a + 4];
          y += args[a + 5];
        } else {
          cx = args[a];
          cy = args[a + 1];
          cx2 = args[a + 2];
          cy2 = args[a + 3];
          x = args[a + 4];
          y = args[a + 5];
        }
        normalized += ["C",cx,cy,cx2,cy2,x,y,''].join(" ");
      }
    } else if (lop === "s") {
      for (a = 0; a < alen; a += 4) {
        // reflect previous cx2/cy2 over x/y
        cx = x + (x - cx2);
        cy = y + (y - cy2);
        // then get real control and end point
        if (op === "s") {
          cx2 = x + args[a];
          cy2 = y + args[a + 1];
          x += args[a + 2];
          y += args[a + 3];
        } else {
          cx2 = args[a];
          cy2 = args[a + 1];
          x = args[a + 2];
          y = args[a + 3];
        }
        normalized +=["C",cx,cy,cx2,cy2,x,y,''].join(" ");
      }
    } else if (lop === "z") {
      normalized += "Z ";
      // not unimportant: path closing changes the current x/y coordinate
      x = sx;
      y = sy;
    }
  }
  return normalized.trim();
}

module.exports = normalizePath;

},{}],10:[function(require,module,exports){
(function() {
  "use strict";

  var utils = require("./utils.js");

  /**
   * Poly Bezier
   * @param {[type]} curves [description]
   */
  var PolyBezier = function(curves) {
    this.curves = [];
    this._3d = false;
    if (!!curves) {
      this.curves = curves;
      this._3d = this.curves[0]._3d;
    }
  };

  PolyBezier.prototype = {
    valueOf: function() {
      return this.toString();
    },
    toString: function() {
      return (
        "[" +
        this.curves
          .map(function(curve) {
            return utils.pointsToString(curve.points);
          })
          .join(", ") +
        "]"
      );
    },
    addCurve: function(curve) {
      this.curves.push(curve);
      this._3d = this._3d || curve._3d;
    },
    length: function() {
      return this.curves
        .map(function(v) {
          return v.length();
        })
        .reduce(function(a, b) {
          return a + b;
        });
    },
    curve: function(idx) {
      return this.curves[idx];
    },
    bbox: function() {
      var c = this.curves;
      var bbox = c[0].bbox();
      for (var i = 1; i < c.length; i++) {
        utils.expandbox(bbox, c[i].bbox());
      }
      return bbox;
    },
    offset: function(d) {
      var offset = [];
      this.curves.forEach(function(v) {
        offset = offset.concat(v.offset(d));
      });
      return new PolyBezier(offset);
    }
  };

  module.exports = PolyBezier;
})();

},{"./utils.js":12}],11:[function(require,module,exports){
var normalise = require("./normalise-svg.js");

var M = { x: false, y: false };

function makeBezier(Bezier, term, values) {
  if (term === 'Z') return;
  if (term === 'M') {
    M = {x: values[0], y: values[1]};
    return;
  }
  // ES7: new Bezier(M.x, M.y, ...values)
  var cvalues = [false, M.x, M.y].concat(values);
  var PreboundConstructor = Bezier.bind.apply(Bezier, cvalues)
  var curve = new PreboundConstructor();
  var last = values.slice(-2);
  M = { x : last[0], y: last[1] };
  return curve;
}

function convertPath(Bezier, d) {
  var terms = normalise(d).split(" "),
    term,
    matcher = new RegExp("[MLCQZ]", ""),
    segment,
    values,
    segments = [],
    ARGS = { "C": 6, "Q": 4, "L": 2, "M": 2};

  while (terms.length) {
    term = terms.splice(0,1)[0];
    if (matcher.test(term)) {
      values = terms.splice(0, ARGS[term]).map(parseFloat);
      segment = makeBezier(Bezier, term, values);
      if (segment) segments.push(segment);
    }
  }

  return new Bezier.PolyBezier(segments);
}

module.exports = convertPath;

},{"./normalise-svg.js":9}],12:[function(require,module,exports){
(function() {
  "use strict";

  // math-inlining.
  var abs = Math.abs,
    cos = Math.cos,
    sin = Math.sin,
    acos = Math.acos,
    atan2 = Math.atan2,
    sqrt = Math.sqrt,
    pow = Math.pow,
    // cube root function yielding real roots
    crt = function(v) {
      return v < 0 ? -pow(-v, 1 / 3) : pow(v, 1 / 3);
    },
    // trig constants
    pi = Math.PI,
    tau = 2 * pi,
    quart = pi / 2,
    // float precision significant decimal
    epsilon = 0.000001,
    // extremas used in bbox calculation and similar algorithms
    nMax = Number.MAX_SAFE_INTEGER || 9007199254740991,
    nMin = Number.MIN_SAFE_INTEGER || -9007199254740991,
    // a zero coordinate, which is surprisingly useful
    ZERO = { x: 0, y: 0, z: 0 };

  // Bezier utility functions
  var utils = {
    // Legendre-Gauss abscissae with n=24 (x_i values, defined at i=n as the roots of the nth order Legendre polynomial Pn(x))
    Tvalues: [
      -0.0640568928626056260850430826247450385909,
      0.0640568928626056260850430826247450385909,
      -0.1911188674736163091586398207570696318404,
      0.1911188674736163091586398207570696318404,
      -0.3150426796961633743867932913198102407864,
      0.3150426796961633743867932913198102407864,
      -0.4337935076260451384870842319133497124524,
      0.4337935076260451384870842319133497124524,
      -0.5454214713888395356583756172183723700107,
      0.5454214713888395356583756172183723700107,
      -0.6480936519369755692524957869107476266696,
      0.6480936519369755692524957869107476266696,
      -0.7401241915785543642438281030999784255232,
      0.7401241915785543642438281030999784255232,
      -0.8200019859739029219539498726697452080761,
      0.8200019859739029219539498726697452080761,
      -0.8864155270044010342131543419821967550873,
      0.8864155270044010342131543419821967550873,
      -0.9382745520027327585236490017087214496548,
      0.9382745520027327585236490017087214496548,
      -0.9747285559713094981983919930081690617411,
      0.9747285559713094981983919930081690617411,
      -0.9951872199970213601799974097007368118745,
      0.9951872199970213601799974097007368118745
    ],

    // Legendre-Gauss weights with n=24 (w_i values, defined by a function linked to in the Bezier primer article)
    Cvalues: [
      0.1279381953467521569740561652246953718517,
      0.1279381953467521569740561652246953718517,
      0.1258374563468282961213753825111836887264,
      0.1258374563468282961213753825111836887264,
      0.121670472927803391204463153476262425607,
      0.121670472927803391204463153476262425607,
      0.1155056680537256013533444839067835598622,
      0.1155056680537256013533444839067835598622,
      0.1074442701159656347825773424466062227946,
      0.1074442701159656347825773424466062227946,
      0.0976186521041138882698806644642471544279,
      0.0976186521041138882698806644642471544279,
      0.086190161531953275917185202983742667185,
      0.086190161531953275917185202983742667185,
      0.0733464814110803057340336152531165181193,
      0.0733464814110803057340336152531165181193,
      0.0592985849154367807463677585001085845412,
      0.0592985849154367807463677585001085845412,
      0.0442774388174198061686027482113382288593,
      0.0442774388174198061686027482113382288593,
      0.0285313886289336631813078159518782864491,
      0.0285313886289336631813078159518782864491,
      0.0123412297999871995468056670700372915759,
      0.0123412297999871995468056670700372915759
    ],

    arcfn: function(t, derivativeFn) {
      var d = derivativeFn(t);
      var l = d.x * d.x + d.y * d.y;
      if (typeof d.z !== "undefined") {
        l += d.z * d.z;
      }
      return sqrt(l);
    },

    compute: function(t, points, _3d) {
      // shortcuts
      if (t === 0) {
        return points[0];
      }

      var order = points.length-1;

      if (t === 1) {
        return points[order];
      }

      var p = points;
      var mt = 1 - t;

      // constant?
      if (order === 0) {
        return points[0];
      }

      // linear?
      if (order === 1) {
        ret = {
          x: mt * p[0].x + t * p[1].x,
          y: mt * p[0].y + t * p[1].y
        };
        if (_3d) {
          ret.z = mt * p[0].z + t * p[1].z;
        }
        return ret;
      }

      // quadratic/cubic curve?
      if (order < 4) {
        var mt2 = mt * mt,
          t2 = t * t,
          a,
          b,
          c,
          d = 0;
        if (order === 2) {
          p = [p[0], p[1], p[2], ZERO];
          a = mt2;
          b = mt * t * 2;
          c = t2;
        } else if (order === 3) {
          a = mt2 * mt;
          b = mt2 * t * 3;
          c = mt * t2 * 3;
          d = t * t2;
        }
        var ret = {
          x: a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x,
          y: a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y
        };
        if (_3d) {
          ret.z = a * p[0].z + b * p[1].z + c * p[2].z + d * p[3].z;
        }
        return ret;
      }

      // higher order curves: use de Casteljau's computation
      var dCpts = JSON.parse(JSON.stringify(points));
      while (dCpts.length > 1) {
        for (var i = 0; i < dCpts.length - 1; i++) {
          dCpts[i] = {
            x: dCpts[i].x + (dCpts[i + 1].x - dCpts[i].x) * t,
            y: dCpts[i].y + (dCpts[i + 1].y - dCpts[i].y) * t
          };
          if (typeof dCpts[i].z !== "undefined") {
            dCpts[i] = dCpts[i].z + (dCpts[i + 1].z - dCpts[i].z) * t;
          }
        }
        dCpts.splice(dCpts.length - 1, 1);
      }
      return dCpts[0];
    },

    computeWithRatios: function (t, points, ratios, _3d) {
      var mt = 1 - t, r = ratios, p = points, d;
      var f1 = r[0], f2 = r[1], f3 = r[2], f4 = r[3];

      // spec for linear
      f1 *= mt;
      f2 *= t;

      if (p.length === 2) {
        d = f1 + f2;
        return {
          x: (f1 * p[0].x + f2 * p[1].x)/d,
          y: (f1 * p[0].y + f2 * p[1].y)/d,
          z: !_3d ? false : (f1 * p[0].z + f2 * p[1].z)/d
        };
      }

      // upgrade to quadratic
      f1 *= mt;
      f2 *= 2 * mt;
      f3 *= t * t;

      if (p.length === 3) {
        d = f1 + f2 + f3;
        return {
          x: (f1 * p[0].x + f2 * p[1].x + f3 * p[2].x)/d,
          y: (f1 * p[0].y + f2 * p[1].y + f3 * p[2].y)/d,
          z: !_3d ? false : (f1 * p[0].z + f2 * p[1].z + f3 * p[2].z)/d
        };
      }

      // upgrade to cubic
      f1 *= mt;
      f2 *= 1.5 * mt;
      f3 *= 3 * mt;
      f4 *= t * t * t;

      if (p.length === 4) {
        d = f1 + f2 + f3 + f4;
        return {
          x: (f1 * p[0].x + f2 * p[1].x + f3 * p[2].x + f4 * p[3].x)/d,
          y: (f1 * p[0].y + f2 * p[1].y + f3 * p[2].y + f4 * p[3].y)/d,
          z: !_3d ? false : (f1 * p[0].z + f2 * p[1].z + f3 * p[2].z + f4 * p[3].z)/d
        };
      }
    },

    derive: function (points, _3d) {
      var dpoints = [];
      for (var p = points, d = p.length, c = d - 1; d > 1; d--, c--) {
        var list = [];
        for (var j = 0, dpt; j < c; j++) {
          dpt = {
            x: c * (p[j + 1].x - p[j].x),
            y: c * (p[j + 1].y - p[j].y)
          };
          if (_3d) {
            dpt.z = c * (p[j + 1].z - p[j].z);
          }
          list.push(dpt);
        }
        dpoints.push(list);
        p = list;
      }
      return dpoints;
    },

    between: function(v, m, M) {
      return (
        (m <= v && v <= M) ||
        utils.approximately(v, m) ||
        utils.approximately(v, M)
      );
    },

    approximately: function(a, b, precision) {
      return abs(a - b) <= (precision || epsilon);
    },

    length: function(derivativeFn) {
      var z = 0.5,
        sum = 0,
        len = utils.Tvalues.length,
        i,
        t;
      for (i = 0; i < len; i++) {
        t = z * utils.Tvalues[i] + z;
        sum += utils.Cvalues[i] * utils.arcfn(t, derivativeFn);
      }
      return z * sum;
    },

    map: function(v, ds, de, ts, te) {
      var d1 = de - ds,
        d2 = te - ts,
        v2 = v - ds,
        r = v2 / d1;
      return ts + d2 * r;
    },

    lerp: function(r, v1, v2) {
      var ret = {
        x: v1.x + r * (v2.x - v1.x),
        y: v1.y + r * (v2.y - v1.y)
      };
      if (!!v1.z && !!v2.z) {
        ret.z = v1.z + r * (v2.z - v1.z);
      }
      return ret;
    },

    pointToString: function(p) {
      var s = p.x + "/" + p.y;
      if (typeof p.z !== "undefined") {
        s += "/" + p.z;
      }
      return s;
    },

    pointsToString: function(points) {
      return "[" + points.map(utils.pointToString).join(", ") + "]";
    },

    copy: function(obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    angle: function(o, v1, v2) {
      var dx1 = v1.x - o.x,
        dy1 = v1.y - o.y,
        dx2 = v2.x - o.x,
        dy2 = v2.y - o.y,
        cross = dx1 * dy2 - dy1 * dx2,
        dot = dx1 * dx2 + dy1 * dy2;
      return atan2(cross, dot);
    },

    // round as string, to avoid rounding errors
    round: function(v, d) {
      var s = "" + v;
      var pos = s.indexOf(".");
      return parseFloat(s.substring(0, pos + 1 + d));
    },

    dist: function(p1, p2) {
      var dx = p1.x - p2.x,
        dy = p1.y - p2.y;
      return sqrt(dx * dx + dy * dy);
    },

    closest: function(LUT, point) {
      var mdist = pow(2, 63),
        mpos,
        d;
      LUT.forEach(function(p, idx) {
        d = utils.dist(point, p);
        if (d < mdist) {
          mdist = d;
          mpos = idx;
        }
      });
      return { mdist: mdist, mpos: mpos };
    },

    abcratio: function(t, n) {
      // see ratio(t) note on http://pomax.github.io/bezierinfo/#abc
      if (n !== 2 && n !== 3) {
        return false;
      }
      if (typeof t === "undefined") {
        t = 0.5;
      } else if (t === 0 || t === 1) {
        return t;
      }
      var bottom = pow(t, n) + pow(1 - t, n),
        top = bottom - 1;
      return abs(top / bottom);
    },

    projectionratio: function(t, n) {
      // see u(t) note on http://pomax.github.io/bezierinfo/#abc
      if (n !== 2 && n !== 3) {
        return false;
      }
      if (typeof t === "undefined") {
        t = 0.5;
      } else if (t === 0 || t === 1) {
        return t;
      }
      var top = pow(1 - t, n),
        bottom = pow(t, n) + top;
      return top / bottom;
    },

    lli8: function(x1, y1, x2, y2, x3, y3, x4, y4) {
      var nx =
          (x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4),
        ny = (x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4),
        d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (d == 0) {
        return false;
      }
      return { x: nx / d, y: ny / d };
    },

    lli4: function(p1, p2, p3, p4) {
      var x1 = p1.x,
        y1 = p1.y,
        x2 = p2.x,
        y2 = p2.y,
        x3 = p3.x,
        y3 = p3.y,
        x4 = p4.x,
        y4 = p4.y;
      return utils.lli8(x1, y1, x2, y2, x3, y3, x4, y4);
    },

    lli: function(v1, v2) {
      return utils.lli4(v1, v1.c, v2, v2.c);
    },

    makeline: function(p1, p2) {
      var Bezier = require("./bezier");
      var x1 = p1.x,
        y1 = p1.y,
        x2 = p2.x,
        y2 = p2.y,
        dx = (x2 - x1) / 3,
        dy = (y2 - y1) / 3;
      return new Bezier(
        x1,
        y1,
        x1 + dx,
        y1 + dy,
        x1 + 2 * dx,
        y1 + 2 * dy,
        x2,
        y2
      );
    },

    findbbox: function(sections) {
      var mx = nMax,
        my = nMax,
        MX = nMin,
        MY = nMin;
      sections.forEach(function(s) {
        var bbox = s.bbox();
        if (mx > bbox.x.min) mx = bbox.x.min;
        if (my > bbox.y.min) my = bbox.y.min;
        if (MX < bbox.x.max) MX = bbox.x.max;
        if (MY < bbox.y.max) MY = bbox.y.max;
      });
      return {
        x: { min: mx, mid: (mx + MX) / 2, max: MX, size: MX - mx },
        y: { min: my, mid: (my + MY) / 2, max: MY, size: MY - my }
      };
    },

    shapeintersections: function(
      s1,
      bbox1,
      s2,
      bbox2,
      curveIntersectionThreshold
    ) {
      if (!utils.bboxoverlap(bbox1, bbox2)) return [];
      var intersections = [];
      var a1 = [s1.startcap, s1.forward, s1.back, s1.endcap];
      var a2 = [s2.startcap, s2.forward, s2.back, s2.endcap];
      a1.forEach(function(l1) {
        if (l1.virtual) return;
        a2.forEach(function(l2) {
          if (l2.virtual) return;
          var iss = l1.intersects(l2, curveIntersectionThreshold);
          if (iss.length > 0) {
            iss.c1 = l1;
            iss.c2 = l2;
            iss.s1 = s1;
            iss.s2 = s2;
            intersections.push(iss);
          }
        });
      });
      return intersections;
    },

    makeshape: function(forward, back, curveIntersectionThreshold) {
      var bpl = back.points.length;
      var fpl = forward.points.length;
      var start = utils.makeline(back.points[bpl - 1], forward.points[0]);
      var end = utils.makeline(forward.points[fpl - 1], back.points[0]);
      var shape = {
        startcap: start,
        forward: forward,
        back: back,
        endcap: end,
        bbox: utils.findbbox([start, forward, back, end])
      };
      var self = utils;
      shape.intersections = function(s2) {
        return self.shapeintersections(
          shape,
          shape.bbox,
          s2,
          s2.bbox,
          curveIntersectionThreshold
        );
      };
      return shape;
    },

    getminmax: function(curve, d, list) {
      if (!list) return { min: 0, max: 0 };
      var min = nMax,
        max = nMin,
        t,
        c;
      if (list.indexOf(0) === -1) {
        list = [0].concat(list);
      }
      if (list.indexOf(1) === -1) {
        list.push(1);
      }
      for (var i = 0, len = list.length; i < len; i++) {
        t = list[i];
        c = curve.get(t);
        if (c[d] < min) {
          min = c[d];
        }
        if (c[d] > max) {
          max = c[d];
        }
      }
      return { min: min, mid: (min + max) / 2, max: max, size: max - min };
    },

    align: function(points, line) {
      var tx = line.p1.x,
        ty = line.p1.y,
        a = -atan2(line.p2.y - ty, line.p2.x - tx),
        d = function(v) {
          return {
            x: (v.x - tx) * cos(a) - (v.y - ty) * sin(a),
            y: (v.x - tx) * sin(a) + (v.y - ty) * cos(a)
          };
        };
      return points.map(d);
    },

    roots: function(points, line) {
      line = line || { p1: { x: 0, y: 0 }, p2: { x: 1, y: 0 } };
      var order = points.length - 1;
      var p = utils.align(points, line);
      var reduce = function(t) {
        return 0 <= t && t <= 1;
      };

      if (order === 2) {
        var a = p[0].y,
          b = p[1].y,
          c = p[2].y,
          d = a - 2 * b + c;
        if (d !== 0) {
          var m1 = -sqrt(b * b - a * c),
            m2 = -a + b,
            v1 = -(m1 + m2) / d,
            v2 = -(-m1 + m2) / d;
          return [v1, v2].filter(reduce);
        } else if (b !== c && d === 0) {
          return [(2*b - c)/(2*b - 2*c)].filter(reduce);
        }
        return [];
      }

      // see http://www.trans4mind.com/personal_development/mathematics/polynomials/cubicAlgebra.htm
      var pa = p[0].y,
        pb = p[1].y,
        pc = p[2].y,
        pd = p[3].y,
        d = -pa + 3 * pb - 3 * pc + pd,
        a = 3 * pa - 6 * pb + 3 * pc,
        b = -3 * pa + 3 * pb,
        c = pa;

      if (utils.approximately(d, 0)) {
        // this is not a cubic curve.
        if (utils.approximately(a, 0)) {
          // in fact, this is not a quadratic curve either.
          if (utils.approximately(b, 0)) {
            // in fact in fact, there are no solutions.
            return [];
          }
          // linear solution:
          return [-c / b].filter(reduce);
        }
        // quadratic solution:
        var q = sqrt(b * b - 4 * a * c),
          a2 = 2 * a;
        return [(q - b) / a2, (-b - q) / a2].filter(reduce);
      }

      // at this point, we know we need a cubic solution:

      a /= d;
      b /= d;
      c /= d;

      var p = (3 * b - a * a) / 3,
        p3 = p / 3,
        q = (2 * a * a * a - 9 * a * b + 27 * c) / 27,
        q2 = q / 2,
        discriminant = q2 * q2 + p3 * p3 * p3,
        u1,
        v1,
        x1,
        x2,
        x3;
      if (discriminant < 0) {
        var mp3 = -p / 3,
          mp33 = mp3 * mp3 * mp3,
          r = sqrt(mp33),
          t = -q / (2 * r),
          cosphi = t < -1 ? -1 : t > 1 ? 1 : t,
          phi = acos(cosphi),
          crtr = crt(r),
          t1 = 2 * crtr;
        x1 = t1 * cos(phi / 3) - a / 3;
        x2 = t1 * cos((phi + tau) / 3) - a / 3;
        x3 = t1 * cos((phi + 2 * tau) / 3) - a / 3;
        return [x1, x2, x3].filter(reduce);
      } else if (discriminant === 0) {
        u1 = q2 < 0 ? crt(-q2) : -crt(q2);
        x1 = 2 * u1 - a / 3;
        x2 = -u1 - a / 3;
        return [x1, x2].filter(reduce);
      } else {
        var sd = sqrt(discriminant);
        u1 = crt(-q2 + sd);
        v1 = crt(q2 + sd);
        return [u1 - v1 - a / 3].filter(reduce);
      }
    },

    droots: function(p) {
      // quadratic roots are easy
      if (p.length === 3) {
        var a = p[0],
          b = p[1],
          c = p[2],
          d = a - 2 * b + c;
        if (d !== 0) {
          var m1 = -sqrt(b * b - a * c),
            m2 = -a + b,
            v1 = -(m1 + m2) / d,
            v2 = -(-m1 + m2) / d;
          return [v1, v2];
        } else if (b !== c && d === 0) {
          return [(2 * b - c) / (2 * (b - c))];
        }
        return [];
      }

      // linear roots are even easier
      if (p.length === 2) {
        var a = p[0],
          b = p[1];
        if (a !== b) {
          return [a / (a - b)];
        }
        return [];
      }
    },

    curvature: function(t, points, _3d, kOnly) {
      var dpoints = utils.derive(points);
      var d1 = dpoints[0];
      var d2 = dpoints[1];
      var num, dnm, adk, dk, k=0, r=0;

      //
      // We're using the following formula for curvature:
      //
      //              x'y" - y'x"
      //   k(t) = ------------------
      //           (x'² + y'²)^(3/2)
      //
      // from https://en.wikipedia.org/wiki/Radius_of_curvature#Definition
      //
      // With it corresponding 3D counterpart:
      //
      //          sqrt( (y'z" - y"z')² + (z'x" - z"x')² + (x'y" - x"y')²)
      //   k(t) = -------------------------------------------------------
      //                     (x'² + y'² + z'²)^(3/2)
      //

      var d = utils.compute(t, d1);
      var dd = utils.compute(t, d2);
      var qdsum = d.x*d.x + d.y*d.y;
      if (_3d) {
        num = sqrt(
          pow(d.y*dd.z - dd.y*d.z, 2) +
          pow(d.z*dd.x - dd.z*d.x, 2) +
          pow(d.x*dd.y - dd.x*d.y, 2)
        );
        dnm = pow(qdsum + d.z*d.z, 3/2);
      } else {
        num = d.x*dd.y - d.y*dd.x;
        dnm = pow(qdsum, 3/2);
      }

      if (num === 0 || dnm === 0) {
        return { k:0, r:0 };
      }

      k = num/dnm;
      r = dnm/num;

      // We're also computing the derivative of kappa, because
      // there is value in knowing the rate of change for the
      // curvature along the curve. And we're just going to
      // ballpark it based on an epsilon.
      if (!kOnly) {
        // compute k'(t) based on the interval before, and after it,
        // to at least try to not introduce forward/backward pass bias.
        var pk = utils.curvature(t-0.001, points, _3d, true).k;
        var nk = utils.curvature(t+0.001, points, _3d, true).k;
        dk = ((nk-k) + (k-pk))/2;
        adk = (abs(nk-k) + abs(k-pk))/2;
      }

      return { k: k, r: r, dk: dk, adk:adk, };
    },

    inflections: function(points) {
      if (points.length < 4) return [];

      // FIXME: TODO: add in inflection abstraction for quartic+ curves?

      var p = utils.align(points, { p1: points[0], p2: points.slice(-1)[0] }),
        a = p[2].x * p[1].y,
        b = p[3].x * p[1].y,
        c = p[1].x * p[2].y,
        d = p[3].x * p[2].y,
        v1 = 18 * (-3 * a + 2 * b + 3 * c - d),
        v2 = 18 * (3 * a - b - 3 * c),
        v3 = 18 * (c - a);

      if (utils.approximately(v1, 0)) {
        if (!utils.approximately(v2, 0)) {
          var t = -v3 / v2;
          if (0 <= t && t <= 1) return [t];
        }
        return [];
      }

      var trm = v2 * v2 - 4 * v1 * v3,
        sq = Math.sqrt(trm),
        d = 2 * v1;

      if (utils.approximately(d, 0)) return [];

      return [(sq - v2) / d, -(v2 + sq) / d].filter(function(r) {
        return 0 <= r && r <= 1;
      });
    },

    bboxoverlap: function(b1, b2) {
      var dims = ["x", "y"],
        len = dims.length,
        i,
        dim,
        l,
        t,
        d;
      for (i = 0; i < len; i++) {
        dim = dims[i];
        l = b1[dim].mid;
        t = b2[dim].mid;
        d = (b1[dim].size + b2[dim].size) / 2;
        if (abs(l - t) >= d) return false;
      }
      return true;
    },

    expandbox: function(bbox, _bbox) {
      if (_bbox.x.min < bbox.x.min) {
        bbox.x.min = _bbox.x.min;
      }
      if (_bbox.y.min < bbox.y.min) {
        bbox.y.min = _bbox.y.min;
      }
      if (_bbox.z && _bbox.z.min < bbox.z.min) {
        bbox.z.min = _bbox.z.min;
      }
      if (_bbox.x.max > bbox.x.max) {
        bbox.x.max = _bbox.x.max;
      }
      if (_bbox.y.max > bbox.y.max) {
        bbox.y.max = _bbox.y.max;
      }
      if (_bbox.z && _bbox.z.max > bbox.z.max) {
        bbox.z.max = _bbox.z.max;
      }
      bbox.x.mid = (bbox.x.min + bbox.x.max) / 2;
      bbox.y.mid = (bbox.y.min + bbox.y.max) / 2;
      if (bbox.z) {
        bbox.z.mid = (bbox.z.min + bbox.z.max) / 2;
      }
      bbox.x.size = bbox.x.max - bbox.x.min;
      bbox.y.size = bbox.y.max - bbox.y.min;
      if (bbox.z) {
        bbox.z.size = bbox.z.max - bbox.z.min;
      }
    },

    pairiteration: function(c1, c2, curveIntersectionThreshold) {
      var c1b = c1.bbox(),
        c2b = c2.bbox(),
        r = 100000,
        threshold = curveIntersectionThreshold || 0.5;
      if (
        c1b.x.size + c1b.y.size < threshold &&
        c2b.x.size + c2b.y.size < threshold
      ) {
        return [
          ((r * (c1._t1 + c1._t2) / 2) | 0) / r +
            "/" +
            ((r * (c2._t1 + c2._t2) / 2) | 0) / r
        ];
      }
      var cc1 = c1.split(0.5),
        cc2 = c2.split(0.5),
        pairs = [
          { left: cc1.left, right: cc2.left },
          { left: cc1.left, right: cc2.right },
          { left: cc1.right, right: cc2.right },
          { left: cc1.right, right: cc2.left }
        ];
      pairs = pairs.filter(function(pair) {
        return utils.bboxoverlap(pair.left.bbox(), pair.right.bbox());
      });
      var results = [];
      if (pairs.length === 0) return results;
      pairs.forEach(function(pair) {
        results = results.concat(
          utils.pairiteration(pair.left, pair.right, threshold)
        );
      });
      results = results.filter(function(v, i) {
        return results.indexOf(v) === i;
      });
      return results;
    },

    getccenter: function(p1, p2, p3) {
      var dx1 = p2.x - p1.x,
        dy1 = p2.y - p1.y,
        dx2 = p3.x - p2.x,
        dy2 = p3.y - p2.y;
      var dx1p = dx1 * cos(quart) - dy1 * sin(quart),
        dy1p = dx1 * sin(quart) + dy1 * cos(quart),
        dx2p = dx2 * cos(quart) - dy2 * sin(quart),
        dy2p = dx2 * sin(quart) + dy2 * cos(quart);
      // chord midpoints
      var mx1 = (p1.x + p2.x) / 2,
        my1 = (p1.y + p2.y) / 2,
        mx2 = (p2.x + p3.x) / 2,
        my2 = (p2.y + p3.y) / 2;
      // midpoint offsets
      var mx1n = mx1 + dx1p,
        my1n = my1 + dy1p,
        mx2n = mx2 + dx2p,
        my2n = my2 + dy2p;
      // intersection of these lines:
      var arc = utils.lli8(mx1, my1, mx1n, my1n, mx2, my2, mx2n, my2n),
        r = utils.dist(arc, p1),
        // arc start/end values, over mid point:
        s = atan2(p1.y - arc.y, p1.x - arc.x),
        m = atan2(p2.y - arc.y, p2.x - arc.x),
        e = atan2(p3.y - arc.y, p3.x - arc.x),
        _;
      // determine arc direction (cw/ccw correction)
      if (s < e) {
        // if s<m<e, arc(s, e)
        // if m<s<e, arc(e, s + tau)
        // if s<e<m, arc(e, s + tau)
        if (s > m || m > e) {
          s += tau;
        }
        if (s > e) {
          _ = e;
          e = s;
          s = _;
        }
      } else {
        // if e<m<s, arc(e, s)
        // if m<e<s, arc(s, e + tau)
        // if e<s<m, arc(s, e + tau)
        if (e < m && m < s) {
          _ = e;
          e = s;
          s = _;
        } else {
          e += tau;
        }
      }
      // assign and done.
      arc.s = s;
      arc.e = e;
      arc.r = r;
      return arc;
    },

    numberSort: function(a, b) {
      return a - b;
    }
  };

  module.exports = utils;
})();

},{"./bezier":8}],13:[function(require,module,exports){

},{}],14:[function(require,module,exports){
/* eslint-disable node/no-deprecated-api */
var buffer = require('buffer')
var Buffer = buffer.Buffer

// alternative to using Object.keys for old browsers
function copyProps (src, dst) {
  for (var key in src) {
    dst[key] = src[key]
  }
}
if (Buffer.from && Buffer.alloc && Buffer.allocUnsafe && Buffer.allocUnsafeSlow) {
  module.exports = buffer
} else {
  // Copy properties from require('buffer')
  copyProps(buffer, exports)
  exports.Buffer = SafeBuffer
}

function SafeBuffer (arg, encodingOrOffset, length) {
  return Buffer(arg, encodingOrOffset, length)
}

// Copy static methods from Buffer
copyProps(Buffer, SafeBuffer)

SafeBuffer.from = function (arg, encodingOrOffset, length) {
  if (typeof arg === 'number') {
    throw new TypeError('Argument must not be a number')
  }
  return Buffer(arg, encodingOrOffset, length)
}

SafeBuffer.alloc = function (size, fill, encoding) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  var buf = Buffer(size)
  if (fill !== undefined) {
    if (typeof encoding === 'string') {
      buf.fill(fill, encoding)
    } else {
      buf.fill(fill)
    }
  } else {
    buf.fill(0)
  }
  return buf
}

SafeBuffer.allocUnsafe = function (size) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  return Buffer(size)
}

SafeBuffer.allocUnsafeSlow = function (size) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  return buffer.SlowBuffer(size)
}

},{"buffer":16}],15:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
/*</replacement>*/

var isEncoding = Buffer.isEncoding || function (encoding) {
  encoding = '' + encoding;
  switch (encoding && encoding.toLowerCase()) {
    case 'hex':case 'utf8':case 'utf-8':case 'ascii':case 'binary':case 'base64':case 'ucs2':case 'ucs-2':case 'utf16le':case 'utf-16le':case 'raw':
      return true;
    default:
      return false;
  }
};

function _normalizeEncoding(enc) {
  if (!enc) return 'utf8';
  var retried;
  while (true) {
    switch (enc) {
      case 'utf8':
      case 'utf-8':
        return 'utf8';
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return 'utf16le';
      case 'latin1':
      case 'binary':
        return 'latin1';
      case 'base64':
      case 'ascii':
      case 'hex':
        return enc;
      default:
        if (retried) return; // undefined
        enc = ('' + enc).toLowerCase();
        retried = true;
    }
  }
};

// Do not cache `Buffer.isEncoding` when checking encoding names as some
// modules monkey-patch it to support additional encodings
function normalizeEncoding(enc) {
  var nenc = _normalizeEncoding(enc);
  if (typeof nenc !== 'string' && (Buffer.isEncoding === isEncoding || !isEncoding(enc))) throw new Error('Unknown encoding: ' + enc);
  return nenc || enc;
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters.
exports.StringDecoder = StringDecoder;
function StringDecoder(encoding) {
  this.encoding = normalizeEncoding(encoding);
  var nb;
  switch (this.encoding) {
    case 'utf16le':
      this.text = utf16Text;
      this.end = utf16End;
      nb = 4;
      break;
    case 'utf8':
      this.fillLast = utf8FillLast;
      nb = 4;
      break;
    case 'base64':
      this.text = base64Text;
      this.end = base64End;
      nb = 3;
      break;
    default:
      this.write = simpleWrite;
      this.end = simpleEnd;
      return;
  }
  this.lastNeed = 0;
  this.lastTotal = 0;
  this.lastChar = Buffer.allocUnsafe(nb);
}

StringDecoder.prototype.write = function (buf) {
  if (buf.length === 0) return '';
  var r;
  var i;
  if (this.lastNeed) {
    r = this.fillLast(buf);
    if (r === undefined) return '';
    i = this.lastNeed;
    this.lastNeed = 0;
  } else {
    i = 0;
  }
  if (i < buf.length) return r ? r + this.text(buf, i) : this.text(buf, i);
  return r || '';
};

StringDecoder.prototype.end = utf8End;

// Returns only complete characters in a Buffer
StringDecoder.prototype.text = utf8Text;

// Attempts to complete a partial non-UTF-8 character using bytes from a Buffer
StringDecoder.prototype.fillLast = function (buf) {
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
  this.lastNeed -= buf.length;
};

// Checks the type of a UTF-8 byte, whether it's ASCII, a leading byte, or a
// continuation byte. If an invalid byte is detected, -2 is returned.
function utf8CheckByte(byte) {
  if (byte <= 0x7F) return 0;else if (byte >> 5 === 0x06) return 2;else if (byte >> 4 === 0x0E) return 3;else if (byte >> 3 === 0x1E) return 4;
  return byte >> 6 === 0x02 ? -1 : -2;
}

// Checks at most 3 bytes at the end of a Buffer in order to detect an
// incomplete multi-byte UTF-8 character. The total number of bytes (2, 3, or 4)
// needed to complete the UTF-8 character (if applicable) are returned.
function utf8CheckIncomplete(self, buf, i) {
  var j = buf.length - 1;
  if (j < i) return 0;
  var nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 1;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 2;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) {
      if (nb === 2) nb = 0;else self.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
}

// Validates as many continuation bytes for a multi-byte UTF-8 character as
// needed or are available. If we see a non-continuation byte where we expect
// one, we "replace" the validated continuation bytes we've seen so far with
// a single UTF-8 replacement character ('\ufffd'), to match v8's UTF-8 decoding
// behavior. The continuation byte check is included three times in the case
// where all of the continuation bytes for a character exist in the same buffer.
// It is also done this way as a slight performance increase instead of using a
// loop.
function utf8CheckExtraBytes(self, buf, p) {
  if ((buf[0] & 0xC0) !== 0x80) {
    self.lastNeed = 0;
    return '\ufffd';
  }
  if (self.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 0xC0) !== 0x80) {
      self.lastNeed = 1;
      return '\ufffd';
    }
    if (self.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 0xC0) !== 0x80) {
        self.lastNeed = 2;
        return '\ufffd';
      }
    }
  }
}

// Attempts to complete a multi-byte UTF-8 character using bytes from a Buffer.
function utf8FillLast(buf) {
  var p = this.lastTotal - this.lastNeed;
  var r = utf8CheckExtraBytes(this, buf, p);
  if (r !== undefined) return r;
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, p, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, p, 0, buf.length);
  this.lastNeed -= buf.length;
}

// Returns all complete UTF-8 characters in a Buffer. If the Buffer ended on a
// partial character, the character's bytes are buffered until the required
// number of bytes are available.
function utf8Text(buf, i) {
  var total = utf8CheckIncomplete(this, buf, i);
  if (!this.lastNeed) return buf.toString('utf8', i);
  this.lastTotal = total;
  var end = buf.length - (total - this.lastNeed);
  buf.copy(this.lastChar, 0, end);
  return buf.toString('utf8', i, end);
}

// For UTF-8, a replacement character is added when ending on a partial
// character.
function utf8End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) return r + '\ufffd';
  return r;
}

// UTF-16LE typically needs two bytes per character, but even if we have an even
// number of bytes available, we need to check if we end on a leading/high
// surrogate. In that case, we need to wait for the next two bytes in order to
// decode the last character properly.
function utf16Text(buf, i) {
  if ((buf.length - i) % 2 === 0) {
    var r = buf.toString('utf16le', i);
    if (r) {
      var c = r.charCodeAt(r.length - 1);
      if (c >= 0xD800 && c <= 0xDBFF) {
        this.lastNeed = 2;
        this.lastTotal = 4;
        this.lastChar[0] = buf[buf.length - 2];
        this.lastChar[1] = buf[buf.length - 1];
        return r.slice(0, -1);
      }
    }
    return r;
  }
  this.lastNeed = 1;
  this.lastTotal = 2;
  this.lastChar[0] = buf[buf.length - 1];
  return buf.toString('utf16le', i, buf.length - 1);
}

// For UTF-16LE we do not explicitly append special replacement characters if we
// end on a partial character, we simply let v8 handle that.
function utf16End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) {
    var end = this.lastTotal - this.lastNeed;
    return r + this.lastChar.toString('utf16le', 0, end);
  }
  return r;
}

function base64Text(buf, i) {
  var n = (buf.length - i) % 3;
  if (n === 0) return buf.toString('base64', i);
  this.lastNeed = 3 - n;
  this.lastTotal = 3;
  if (n === 1) {
    this.lastChar[0] = buf[buf.length - 1];
  } else {
    this.lastChar[0] = buf[buf.length - 2];
    this.lastChar[1] = buf[buf.length - 1];
  }
  return buf.toString('base64', i, buf.length - n);
}

function base64End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) return r + this.lastChar.toString('base64', 0, 3 - this.lastNeed);
  return r;
}

// Pass bytes on through for single-byte encodings (e.g. ascii, latin1, hex)
function simpleWrite(buf) {
  return buf.toString(this.encoding);
}

function simpleEnd(buf) {
  return buf && buf.length ? this.write(buf) : '';
}
},{"safe-buffer":14}],16:[function(require,module,exports){
(function (Buffer){(function (){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

}).call(this)}).call(this,require("buffer").Buffer)
},{"base64-js":6,"buffer":16,"ieee754":17}],17:[function(require,module,exports){
/*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> */
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],18:[function(require,module,exports){
/*  Adapted from pdf.js's colorspace module
    (https://github.com/mozilla/pdf.js/blob/a18290759227c894f8f97f58c8da8ce942f5a38f/src/core/colorspace.js)

    Released under the Apache 2.0 license:
    https://github.com/mozilla/pdf.js/blob/master/LICENSE
*/
/**
 *
 * @param {[number,number,number,number]} src CMYK values (0-100)
 * @returns {Uint8ClampedArray} RGB values (0-255)
 */
module.exports = function convertToRgb(src) {
  const toFraction = 1 / 100
  const rgb = new Uint8ClampedArray(3)

  const c = src[0] * toFraction
  const m = src[1] * toFraction
  const y = src[2] * toFraction
  const k = src[3] * toFraction

  rgb[0] =
    255 +
    c *
      (-4.387332384609988 * c +
        54.48615194189176 * m +
        18.82290502165302 * y +
        212.25662451639585 * k +
        -285.2331026137004) +
    m *
      (1.7149763477362134 * m -
        5.6096736904047315 * y +
        -17.873870861415444 * k -
        5.497006427196366) +
    y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) +
    k * (-21.86122147463605 * k - 189.48180835922747)

  rgb[1] =
    255 +
    c *
      (8.841041422036149 * c +
        60.118027045597366 * m +
        6.871425592049007 * y +
        31.159100130055922 * k +
        -79.2970844816548) +
    m *
      (-15.310361306967817 * m +
        17.575251261109482 * y +
        131.35250912493976 * k -
        190.9453302588951) +
    y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) +
    k * (-20.737325471181034 * k - 187.80453709719578)

  rgb[2] =
    255 +
    c *
      (0.8842522430003296 * c +
        8.078677503112928 * m +
        30.89978309703729 * y -
        0.23883238689178934 * k +
        -14.183576799673286) +
    m *
      (10.49593273432072 * m +
        63.02378494754052 * y +
        50.606957656360734 * k -
        112.23884253719248) +
    y *
      (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) +
    k * (-22.33816807309886 * k - 180.12613974708367)

  return rgb
}

},{}],19:[function(require,module,exports){
const readOcad = require('./ocad-reader')
const ocadToGeoJson = require('./ocad-to-geojson')
const { ocadToSvg } = require('./ocad-to-svg')
const ocadToQml = require('./ocad-to-qml')
const ocadToMapboxGlStyle = require('./ocad-to-mapbox-gl-style')

module.exports = {
  readOcad,
  ocadToGeoJson,
  ocadToSvg,
  ocadToMapboxGlStyle,
  ocadToQml,
}

},{"./ocad-reader":25,"./ocad-to-geojson":44,"./ocad-to-mapbox-gl-style":45,"./ocad-to-qml":46,"./ocad-to-svg":47}],20:[function(require,module,exports){
const { Symbol10, Symbol11 } = require('./symbol')

/**
 * @typedef {import('./buffer-reader')} BufferReader
 */

/**
 * @typedef {import('./symbol-element')} SymbolElement
 */

/**
 * @typedef {object} AreaSymbolProps
 *
 * @property {3} type
 * @property {number} borderSym
 * @property {number} fillColor
 * @property {number} hatchMode
 * @property {number} hatchColor
 * @property {number} hatchLineWidth
 * @property {number} hatchDist
 * @property {number} hatchAngle1
 * @property {number} hatchAngle2
 * @property {boolean} fillOn
 * @property {boolean} borderOn
 * @property {number} structMode
 * @property {number} structWidth
 * @property {number} structHeight
 * @property {number} structAngle
 * @property {number} structRes
 * @property {number} dataSize
 * @property {SymbolElement[]} elements
 */

/** @typedef {import('./symbol').BaseSymbolProps & AreaSymbolProps} AreaSymbolDef */

/** @implements {AreaSymbolDef} */
class AreaSymbol10 extends Symbol10 {
  /**
   * @type {3}
   */
  type
  /**
   * @type {number}
   */
  borderSym
  /**
   * @type {number}
   */
  fillColor
  /**
   * @type {number}
   */
  hatchMode
  /**
   * @type {number}
   */
  hatchColor
  /**
   * @type {number}
   */
  hatchLineWidth
  /**
   * @type {number}
   */
  hatchDist
  /**
   * @type {number}
   */
  hatchAngle1
  /**
   * @type {number}
   */
  hatchAngle2
  /**
   * @type {boolean}
   */
  fillOn
  /**
   * @type {boolean}
   */
  borderOn
  /**
   * @type {number}
   */
  structMode
  /**
   * @type {number}
   */
  structWidth
  /**
   * @type {number}
   */
  structHeight
  /**
   * @type {number}
   */
  structAngle
  /**
   * @type {number}
   */
  structRes
  /**
   * @type {number}
   */
  dataSize
  /**
   * @type {SymbolElement[]}
   */
  elements

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    this.type = 3
    this.borderSym = reader.readInteger()
    this.fillColor = reader.readSmallInt()
    this.hatchMode = reader.readSmallInt()
    this.hatchColor = reader.readSmallInt()
    this.hatchLineWidth = reader.readSmallInt()
    this.hatchDist = reader.readSmallInt()
    this.hatchAngle1 = reader.readSmallInt()
    this.hatchAngle2 = reader.readSmallInt()
    this.fillOn = !!reader.readByte()
    this.borderOn = !!reader.readByte()
    this.structMode = reader.readSmallInt()
    this.structWidth = reader.readSmallInt()
    this.structHeight = reader.readSmallInt()
    this.structAngle = reader.readSmallInt()
    this.structRes = reader.readSmallInt()
    this.dataSize = reader.readWord()

    this.elements = this.readElements(reader, this.dataSize)
  }
}

/** @implements {AreaSymbolDef} */
class AreaSymbol11 extends Symbol11 {
  /**
   * @type {3}
   */
  type

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    // TODO: why?
    reader.skip(64)

    this.type = 3
    this.borderSym = reader.readInteger()
    this.fillColor = reader.readSmallInt()
    this.hatchMode = reader.readSmallInt()
    this.hatchColor = reader.readSmallInt()
    this.hatchLineWidth = reader.readSmallInt()
    this.hatchDist = reader.readSmallInt()
    this.hatchAngle1 = reader.readSmallInt()
    this.hatchAngle2 = reader.readSmallInt()
    this.fillOn = !!reader.readByte()
    this.borderOn = !!reader.readByte()
    this.structMode = reader.readSmallInt()
    this.structWidth = reader.readSmallInt()
    this.structHeight = reader.readSmallInt()
    this.structAngle = reader.readSmallInt()
    this.structRes = reader.readSmallInt()
    this.dataSize = reader.readWord()

    this.elements = this.readElements(reader, this.dataSize)
  }
}

/** @implements {AreaSymbolDef} */
class AreaSymbol12 extends Symbol11 {
  /**
   * @type {3}
   */
  type

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    // TODO: why?
    reader.skip(64)

    this.type = 3
    this.borderSym = reader.readInteger()
    this.fillColor = reader.readSmallInt()
    this.hatchMode = reader.readSmallInt()
    this.hatchColor = reader.readSmallInt()
    this.hatchLineWidth = reader.readSmallInt()
    this.hatchDist = reader.readSmallInt()
    this.hatchAngle1 = reader.readSmallInt()
    this.hatchAngle2 = reader.readSmallInt()
    this.fillOn = !!reader.readByte()
    this.borderOn = !!reader.readByte()
    this.structMode = reader.readByte()
    this.structDraw = reader.readByte()
    this.structWidth = reader.readSmallInt()
    this.structHeight = reader.readSmallInt()
    this.structAngle = reader.readSmallInt()
    this.structIrregularVarX = reader.readByte()
    this.structIrregularVarY = reader.readByte()
    this.structIrregularMinDist = reader.readSmallInt()
    this.structRes = reader.readSmallInt()
    this.dataSize = reader.readWord()

    this.elements = this.readElements(reader, this.dataSize)
  }
}

module.exports = {
  10: AreaSymbol10,
  11: AreaSymbol11,
  12: AreaSymbol12,
  2018: AreaSymbol12,
}

},{"./symbol":40}],21:[function(require,module,exports){
/**
 * Encapsulates reading binary values for a buffer using the type names
 * used in the OCAD file format specification.
 *
 * The reader also supports pushing and popping the current offset like a stack,
 * which is useful when reading nested structures.
 *
 * @property {number} offset
 * @property {number[]} stack
 */
module.exports = class BufferReader {
  /**
   * @type {import('buffer').Buffer}
   */
  buffer
  /**
   * @type {number}
   */
  offset
  /**
   * @type {number[]}
   */
  stack

  /**
   * Constructs a new reader from the buffer, starting a the given offset.
   * @param {import('buffer').Buffer} buffer
   * @param {number} offset
   */
  constructor(buffer, offset = 0) {
    this.buffer = buffer
    this.offset = offset

    this.stack = []
  }

  readInteger() {
    const val = this.buffer.readInt32LE(this.offset)
    this.offset += 4
    return val
  }

  readCardinal() {
    const val = this.buffer.readUInt32LE(this.offset)
    this.offset += 4
    return val
  }

  readSmallInt() {
    const val = this.buffer.readInt16LE(this.offset)
    this.offset += 2
    return val
  }

  readByte() {
    const val = this.buffer.readInt8(this.offset)
    this.offset++
    return val
  }

  readWord() {
    const val = this.buffer.readUInt16LE(this.offset)
    this.offset += 2
    return val
  }

  readWordBool() {
    return !!this.readWord()
  }

  readDouble() {
    const val = this.buffer.readDoubleLE(this.offset)
    this.offset += 8
    return val
  }

  /**
   * Reads a OCAD "wide string" from the buffer. For some OCAD versions,
   * a wide string is a string of 16-bit characters, for others it is a
   * string of 32-bit characters; setting the unicode parameter to true
   * will read 16-bit characters.
   *
   * If the length parameter is not given, the length of the string is read
   * as the first byte from the buffer.
   *
   * @param {boolean} unicode Whether to read 16-bit or 32-bit characters
   * @param {number=} len The length of the string
   * @returns {string}
   */
  readWideString(unicode, len) {
    if (len == null) {
      len = this.readByte()
    }

    const textChars = []
    for (let i = 0; i < len * (unicode ? 2 : 4); i++) {
      const c = unicode ? this.readByte() : this.readWord()
      if (!c) break
      textChars.push(String.fromCharCode(c))
    }

    return (
      textChars
        // Filter carriage returns
        .filter(c => c !== '\r')
        .join('')
        .trim()
    )
  }

  /**
   * Returns the number of bytes read since the last push() call.
   * @returns {number}
   */
  getSize() {
    return this.offset - this.stack[this.stack.length - 1]
  }

  /**
   * Skips the given number of bytes.
   * @param {number} bytes
   */
  skip(bytes) {
    this.offset += bytes
  }

  /**
   * Pushes the current offset onto the stack and sets the offset to the given
   * value.
   * @param {number} offset
   */
  push(offset) {
    this.stack.push(this.offset)
    this.offset = offset
  }

  /**
   * Pops the current offset from the stack.
   */
  pop() {
    const nextOffset = this.stack.pop()
    if (nextOffset == null) throw new Error('Stack underflow')
    this.offset = nextOffset
  }
}

},{}],22:[function(require,module,exports){
// Copied and adapted from
// https://github.com/doppelmeter/OCAD-Grid-ID_to_EPSG
//
// OCAD-Grid-ID;CRS-Code;CRS-Catalog;Name;Comment

/** @typedef {[number, number, string, string]} GridDef */

/**
 * @type {GridDef[]}
 */
module.exports = [
  [-2060, 32760, 'EPSG', 'WGS 84 / UTM zone 60S'],
  [-2059, 32759, 'EPSG', 'WGS 84 / UTM zone 59S'],
  [-2058, 32758, 'EPSG', 'WGS 84 / UTM zone 58S'],
  [-2057, 32757, 'EPSG', 'WGS 84 / UTM zone 57S'],
  [-2056, 32756, 'EPSG', 'WGS 84 / UTM zone 56S'],
  [-2055, 32755, 'EPSG', 'WGS 84 / UTM zone 55S'],
  [-2054, 32754, 'EPSG', 'WGS 84 / UTM zone 54S'],
  [-2053, 32753, 'EPSG', 'WGS 84 / UTM zone 53S'],
  [-2052, 32752, 'EPSG', 'WGS 84 / UTM zone 52S'],
  [-2051, 32751, 'EPSG', 'WGS 84 / UTM zone 51S'],
  [-2050, 32750, 'EPSG', 'WGS 84 / UTM zone 50S'],
  [-2049, 32749, 'EPSG', 'WGS 84 / UTM zone 49S'],
  [-2048, 32748, 'EPSG', 'WGS 84 / UTM zone 48S'],
  [-2047, 32747, 'EPSG', 'WGS 84 / UTM zone 47S'],
  [-2046, 32746, 'EPSG', 'WGS 84 / UTM zone 46S'],
  [-2045, 32745, 'EPSG', 'WGS 84 / UTM zone 45S'],
  [-2044, 32744, 'EPSG', 'WGS 84 / UTM zone 44S'],
  [-2043, 32743, 'EPSG', 'WGS 84 / UTM zone 43S'],
  [-2042, 32742, 'EPSG', 'WGS 84 / UTM zone 42S'],
  [-2041, 32741, 'EPSG', 'WGS 84 / UTM zone 41S'],
  [-2040, 32740, 'EPSG', 'WGS 84 / UTM zone 40S'],
  [-2039, 32739, 'EPSG', 'WGS 84 / UTM zone 39S'],
  [-2038, 32738, 'EPSG', 'WGS 84 / UTM zone 38S'],
  [-2037, 32737, 'EPSG', 'WGS 84 / UTM zone 37S'],
  [-2036, 32736, 'EPSG', 'WGS 84 / UTM zone 36S'],
  [-2035, 32735, 'EPSG', 'WGS 84 / UTM zone 35S'],
  [-2034, 32734, 'EPSG', 'WGS 84 / UTM zone 34S'],
  [-2033, 32733, 'EPSG', 'WGS 84 / UTM zone 33S'],
  [-2032, 32732, 'EPSG', 'WGS 84 / UTM zone 32S'],
  [-2031, 32731, 'EPSG', 'WGS 84 / UTM zone 31S'],
  [-2030, 32730, 'EPSG', 'WGS 84 / UTM zone 30S'],
  [-2029, 32729, 'EPSG', 'WGS 84 / UTM zone 29S'],
  [-2028, 32728, 'EPSG', 'WGS 84 / UTM zone 28S'],
  [-2027, 32727, 'EPSG', 'WGS 84 / UTM zone 27S'],
  [-2026, 32726, 'EPSG', 'WGS 84 / UTM zone 26S'],
  [-2025, 32725, 'EPSG', 'WGS 84 / UTM zone 25S'],
  [-2024, 32724, 'EPSG', 'WGS 84 / UTM zone 24S'],
  [-2023, 32723, 'EPSG', 'WGS 84 / UTM zone 23S'],
  [-2022, 32722, 'EPSG', 'WGS 84 / UTM zone 22S'],
  [-2021, 32721, 'EPSG', 'WGS 84 / UTM zone 21S'],
  [-2020, 32720, 'EPSG', 'WGS 84 / UTM zone 20S'],
  [-2019, 32719, 'EPSG', 'WGS 84 / UTM zone 19S'],
  [-2018, 32718, 'EPSG', 'WGS 84 / UTM zone 18S'],
  [-2017, 32717, 'EPSG', 'WGS 84 / UTM zone 17S'],
  [-2016, 32716, 'EPSG', 'WGS 84 / UTM zone 16S'],
  [-2015, 32715, 'EPSG', 'WGS 84 / UTM zone 15S'],
  [-2014, 32714, 'EPSG', 'WGS 84 / UTM zone 14S'],
  [-2013, 32713, 'EPSG', 'WGS 84 / UTM zone 13S'],
  [-2012, 32712, 'EPSG', 'WGS 84 / UTM zone 12S'],
  [-2011, 32711, 'EPSG', 'WGS 84 / UTM zone 11S'],
  [-2010, 32710, 'EPSG', 'WGS 84 / UTM zone 10S'],
  [-2009, 32709, 'EPSG', 'WGS 84 / UTM zone 9S'],
  [-2008, 32708, 'EPSG', 'WGS 84 / UTM zone 8S'],
  [-2007, 32707, 'EPSG', 'WGS 84 / UTM zone 7S'],
  [-2006, 32706, 'EPSG', 'WGS 84 / UTM zone 6S'],
  [-2005, 32705, 'EPSG', 'WGS 84 / UTM zone 5S'],
  [-2004, 32704, 'EPSG', 'WGS 84 / UTM zone 4S'],
  [-2003, 32703, 'EPSG', 'WGS 84 / UTM zone 3S'],
  [-2002, 32702, 'EPSG', 'WGS 84 / UTM zone 2S'],
  [-2001, 32701, 'EPSG', 'WGS 84 / UTM zone 1S'],
  [2001, 32601, 'EPSG', 'WGS 84 / UTM zone 1N'],
  [2002, 32602, 'EPSG', 'WGS 84 / UTM zone 2N'],
  [2003, 32603, 'EPSG', 'WGS 84 / UTM zone 3N'],
  [2004, 32604, 'EPSG', 'WGS 84 / UTM zone 4N'],
  [2005, 32605, 'EPSG', 'WGS 84 / UTM zone 5N'],
  [2006, 32606, 'EPSG', 'WGS 84 / UTM zone 6N'],
  [2007, 32607, 'EPSG', 'WGS 84 / UTM zone 7N'],
  [2008, 32608, 'EPSG', 'WGS 84 / UTM zone 8N'],
  [2009, 32609, 'EPSG', 'WGS 84 / UTM zone 9N'],
  [2010, 32610, 'EPSG', 'WGS 84 / UTM zone 10N'],
  [2011, 32611, 'EPSG', 'WGS 84 / UTM zone 11N'],
  [2012, 32612, 'EPSG', 'WGS 84 / UTM zone 12N'],
  [2013, 32613, 'EPSG', 'WGS 84 / UTM zone 13N'],
  [2014, 32614, 'EPSG', 'WGS 84 / UTM zone 14N'],
  [2015, 32615, 'EPSG', 'WGS 84 / UTM zone 15N'],
  [2016, 32616, 'EPSG', 'WGS 84 / UTM zone 16N'],
  [2017, 32617, 'EPSG', 'WGS 84 / UTM zone 17N'],
  [2018, 32618, 'EPSG', 'WGS 84 / UTM zone 18N'],
  [2019, 32619, 'EPSG', 'WGS 84 / UTM zone 19N'],
  [2020, 32620, 'EPSG', 'WGS 84 / UTM zone 20N'],
  [2021, 32621, 'EPSG', 'WGS 84 / UTM zone 21N'],
  [2022, 32622, 'EPSG', 'WGS 84 / UTM zone 22N'],
  [2023, 32623, 'EPSG', 'WGS 84 / UTM zone 23N'],
  [2024, 32624, 'EPSG', 'WGS 84 / UTM zone 24N'],
  [2025, 32625, 'EPSG', 'WGS 84 / UTM zone 25N'],
  [2026, 32626, 'EPSG', 'WGS 84 / UTM zone 26N'],
  [2027, 32627, 'EPSG', 'WGS 84 / UTM zone 27N'],
  [2028, 32628, 'EPSG', 'WGS 84 / UTM zone 28N'],
  [2029, 32629, 'EPSG', 'WGS 84 / UTM zone 29N'],
  [2030, 32630, 'EPSG', 'WGS 84 / UTM zone 30N'],
  [2031, 32631, 'EPSG', 'WGS 84 / UTM zone 31N'],
  [2032, 32632, 'EPSG', 'WGS 84 / UTM zone 32N'],
  [2033, 32633, 'EPSG', 'WGS 84 / UTM zone 33N'],
  [2034, 32634, 'EPSG', 'WGS 84 / UTM zone 34N'],
  [2035, 32635, 'EPSG', 'WGS 84 / UTM zone 35N'],
  [2036, 32636, 'EPSG', 'WGS 84 / UTM zone 36N'],
  [2037, 32637, 'EPSG', 'WGS 84 / UTM zone 37N'],
  [2038, 32638, 'EPSG', 'WGS 84 / UTM zone 38N'],
  [2039, 32639, 'EPSG', 'WGS 84 / UTM zone 39N'],
  [2040, 32640, 'EPSG', 'WGS 84 / UTM zone 40N'],
  [2041, 32641, 'EPSG', 'WGS 84 / UTM zone 41N'],
  [2042, 32642, 'EPSG', 'WGS 84 / UTM zone 42N'],
  [2043, 32643, 'EPSG', 'WGS 84 / UTM zone 43N'],
  [2044, 32644, 'EPSG', 'WGS 84 / UTM zone 44N'],
  [2045, 32645, 'EPSG', 'WGS 84 / UTM zone 45N'],
  [2046, 32646, 'EPSG', 'WGS 84 / UTM zone 46N'],
  [2047, 32647, 'EPSG', 'WGS 84 / UTM zone 47N'],
  [2048, 32648, 'EPSG', 'WGS 84 / UTM zone 48N'],
  [2049, 32649, 'EPSG', 'WGS 84 / UTM zone 49N'],
  [2050, 32650, 'EPSG', 'WGS 84 / UTM zone 50N'],
  [2051, 32651, 'EPSG', 'WGS 84 / UTM zone 51N'],
  [2052, 32652, 'EPSG', 'WGS 84 / UTM zone 52N'],
  [2053, 32653, 'EPSG', 'WGS 84 / UTM zone 53N'],
  [2054, 32654, 'EPSG', 'WGS 84 / UTM zone 54N'],
  [2055, 32655, 'EPSG', 'WGS 84 / UTM zone 55N'],
  [2056, 32656, 'EPSG', 'WGS 84 / UTM zone 56N'],
  [2057, 32657, 'EPSG', 'WGS 84 / UTM zone 57N'],
  [2058, 32658, 'EPSG', 'WGS 84 / UTM zone 58N'],
  [2059, 32659, 'EPSG', 'WGS 84 / UTM zone 59N'],
  [2060, 32660, 'EPSG', 'WGS 84 / UTM zone 60N'],
  [3028, 31257, 'EPSG', 'MGI / Austria GK M28'],
  [3031, 31258, 'EPSG', 'MGI / Austria GK M31'],
  [3034, 31259, 'EPSG', 'MGI / Austria GK M34'],
  [3035, 31254, 'EPSG', 'MGI / Austria GK West'],
  [3036, 31255, 'EPSG', 'MGI / Austria GK Central'],
  [3038, 31256, 'EPSG', 'MGI / Austria GK East'],
  [4001, 31300, 'EPSG', 'Belge 1972 / Belge Lambert 72'],
  [4002, 3447, 'EPSG', 'ETRS89 / Belgian Lambert 2005'],
  [4003, 3812, 'EPSG', 'ETRS89 / Belgian Lambert 2008'],
  [5000, 27700, 'EPSG', 'OSGB 1936 / British National Grid'],
  [6001, 2391, 'EPSG', 'KKJ / Finland zone 1'],
  [6002, 2392, 'EPSG', 'KKJ / Finland zone 2'],
  [6003, 2393, 'EPSG', 'KKJ / Finland Uniform Coordinate System'],
  [6004, 2394, 'EPSG', 'KKJ / Finland zone 4'],
  [6005, 3067, 'EPSG', 'ETRS89 / TM35FIN(E N)'],
  [6006, 3873, 'EPSG', 'ETRS89 / GK19FIN'],
  [6007, 3874, 'EPSG', 'ETRS89 / GK20FIN'],
  [6008, 3875, 'EPSG', 'ETRS89 / GK21FIN'],
  [6009, 3876, 'EPSG', 'ETRS89 / GK22FIN'],
  [6010, 3877, 'EPSG', 'ETRS89 / GK23FIN'],
  [6011, 3878, 'EPSG', 'ETRS89 / GK24FIN'],
  [6012, 3879, 'EPSG', 'ETRS89 / GK25FIN'],
  [6013, 3880, 'EPSG', 'ETRS89 / GK26FIN'],
  [6014, 3881, 'EPSG', 'ETRS89 / GK27FIN'],
  [6015, 3882, 'EPSG', 'ETRS89 / GK28FIN'],
  [6016, 3883, 'EPSG', 'ETRS89 / GK29FIN'],
  [6017, 3884, 'EPSG', 'ETRS89 / GK30FIN'],
  [6018, 3885, 'EPSG', 'ETRS89 / GK31FIN'],
  [6019, 3126, 'EPSG', 'ETRS89 / ETRS-GK19FIN'],
  [6020, 3127, 'EPSG', 'ETRS89 / ETRS-GK20FIN'],
  [6021, 3128, 'EPSG', 'ETRS89 / ETRS-GK21FIN'],
  [6022, 3129, 'EPSG', 'ETRS89 / ETRS-GK22FIN'],
  [6023, 3130, 'EPSG', 'ETRS89 / ETRS-GK23FIN'],
  [6024, 3131, 'EPSG', 'ETRS89 / ETRS-GK24FIN'],
  [6025, 3132, 'EPSG', 'ETRS89 / ETRS-GK25FIN'],
  [6026, 3133, 'EPSG', 'ETRS89 / ETRS-GK26FIN'],
  [6027, 3134, 'EPSG', 'ETRS89 / ETRS-GK27FIN'],
  [6028, 3135, 'EPSG', 'ETRS89 / ETRS-GK28FIN'],
  [6029, 3136, 'EPSG', 'ETRS89 / ETRS-GK29FIN'],
  [6030, 3137, 'EPSG', 'ETRS89 / ETRS-GK30FIN'],
  [6031, 3138, 'EPSG', 'ETRS89 / ETRS-GK31FIN'],
  [6032, 3387, 'EPSG', 'KKJ / Finland zone 5'],
  [
    7001,
    27591,
    'EPSG',
    'NTF (Paris) / Nord France;#Deprecated: Changed projCRS name. Use EPSG:27561 instead',
  ],
  [
    7002,
    27581,
    'EPSG',
    'NTF (Paris) / France I;#Deprecated: Changed projCRS name. Use EPSG:27571 instead',
  ],
  [
    7003,
    27592,
    'EPSG',
    'NTF (Paris) / Centre France;#Deprecated: Changed projCRS name. Use EPSG:27562 instead',
  ],
  [7004, 27572, 'EPSG', 'NTF (Paris) / Lambert zone II'],
  [
    7005,
    27593,
    'EPSG',
    'NTF (Paris) / Sud France;#Deprecated: Changed projCRS name. Use EPSG:27563 instead',
  ],
  [
    7006,
    27583,
    'EPSG',
    'NTF (Paris) / France III;#Deprecated: Changed projCRS name. Use EPSG:27573 instead',
  ],
  [
    7007,
    27594,
    'EPSG',
    'NTF (Paris) / Corse;#Deprecated: Changed projCRS name. Use EPSG:27564 instead',
  ],
  [
    7008,
    27584,
    'EPSG',
    'NTF (Paris) / France IV;#Deprecated: Changed projCRS name. Use EPSG:27574 instead',
  ],
  [7009, 2154, 'EPSG', 'RGF93 / Lambert-93'],
  [7010, 3942, 'EPSG', 'RGF93 / CC42'],
  [7011, 3943, 'EPSG', 'RGF93 / CC43'],
  [7012, 3944, 'EPSG', 'RGF93 / CC44'],
  [7013, 3945, 'EPSG', 'RGF93 / CC45'],
  [7014, 3946, 'EPSG', 'RGF93 / CC46'],
  [7015, 3947, 'EPSG', 'RGF93 / CC47'],
  [7016, 3948, 'EPSG', 'RGF93 / CC48'],
  [7017, 3949, 'EPSG', 'RGF93 / CC49'],
  [7018, 3950, 'EPSG', 'RGF93 / CC50'],
  [8002, 31466, 'EPSG', 'DHDN / 3-degree Gauss-Kruger zone 2'],
  [8003, 31467, 'EPSG', 'DHDN / 3-degree Gauss-Kruger zone 3'],
  [8004, 31468, 'EPSG', 'DHDN / 3-degree Gauss-Kruger zone 4'],
  [8005, 31469, 'EPSG', 'DHDN / 3-degree Gauss-Kruger zone 5'],
  [8006, 25831, 'EPSG', 'ETRS89 / UTM zone 31N'],
  [8007, 25832, 'EPSG', 'ETRS89 / UTM zone 32N'],
  [8008, 25833, 'EPSG', 'ETRS89 / UTM zone 33N'],
  [8009, 0, ';', 'TRS89 32N 7Stellen;#CRS-Code missing in OCA'],
  [8010, 0, ';', 'TRS89 33N 7Stellen;#CRS-Code missing in OCA'],
  [8011, 0, ';', 'TRS89 32N 8Stellen;#CRS-Code missing in OCA'],
  [8012, 0, ';', 'TRS89 33N 8Stellen;#CRS-Code missing in OCA'],
  [8013, 3068, 'EPSG', 'DHDN / Soldner Berlin'],
  [8014, 3068, 'EPSG', 'DHDN / Soldner Berlin'],
  [9001, 29902, 'EPSG', 'TM65 / Irish Grid'],
  [9002, 29903, 'EPSG', 'TM75 / Irish Grid'],
  [9003, 2157, 'EPSG', 'IRENET95 / Irish Transverse Mercator'],
  [11001, 30161, 'EPSG', 'Tokyo / Japan Plane Rectangular CS I'],
  [11002, 30162, 'EPSG', 'Tokyo / Japan Plane Rectangular CS II'],
  [11003, 30163, 'EPSG', 'Tokyo / Japan Plane Rectangular CS III'],
  [11004, 30164, 'EPSG', 'Tokyo / Japan Plane Rectangular CS IV'],
  [11005, 30165, 'EPSG', 'Tokyo / Japan Plane Rectangular CS V'],
  [11006, 30166, 'EPSG', 'Tokyo / Japan Plane Rectangular CS VI'],
  [11007, 30167, 'EPSG', 'Tokyo / Japan Plane Rectangular CS VII'],
  [11008, 30168, 'EPSG', 'Tokyo / Japan Plane Rectangular CS VIII'],
  [11009, 30169, 'EPSG', 'Tokyo / Japan Plane Rectangular CS IX'],
  [11010, 30170, 'EPSG', 'Tokyo / Japan Plane Rectangular CS X'],
  [11011, 30171, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XI'],
  [11012, 30172, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XII'],
  [11013, 30173, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XIII'],
  [11014, 30174, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XIV'],
  [11015, 30175, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XV'],
  [11016, 30176, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XVI'],
  [11017, 30177, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XVII'],
  [11018, 30178, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XVIII'],
  [11019, 30179, 'EPSG', 'Tokyo / Japan Plane Rectangular CS XIX'],
  [11020, 2443, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS I'],
  [11021, 2444, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS II'],
  [11022, 2445, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS III'],
  [11023, 2446, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS IV'],
  [11024, 2447, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS V'],
  [11025, 2448, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS VI'],
  [11026, 2449, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS VII'],
  [11027, 2450, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS VIII'],
  [11028, 2451, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS IX'],
  [11029, 2452, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS X'],
  [11030, 2453, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XI'],
  [11031, 2454, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XII'],
  [11032, 2455, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XIII'],
  [11033, 2456, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XIV'],
  [11034, 2457, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XV'],
  [11035, 2458, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XVI'],
  [11036, 2459, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XVII'],
  [11037, 2460, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XVIII'],
  [11039, 2461, 'EPSG', 'JGD2000 / Japan Plane Rectangular CS XIX'],
  [12001, 27391, 'EPSG', 'NGO 1948 (Oslo) / NGO zone I'],
  [12002, 27392, 'EPSG', 'NGO 1948 (Oslo) / NGO zone II'],
  [12003, 27393, 'EPSG', 'NGO 1948 (Oslo) / NGO zone III'],
  [12004, 27394, 'EPSG', 'NGO 1948 (Oslo) / NGO zone IV'],
  [12005, 27395, 'EPSG', 'NGO 1948 (Oslo) / NGO zone V'],
  [12006, 27396, 'EPSG', 'NGO 1948 (Oslo) / NGO zone VI'],
  [12007, 27397, 'EPSG', 'NGO 1948 (Oslo) / NGO zone VII'],
  [12008, 27398, 'EPSG', 'NGO 1948 (Oslo) / NGO zone VIII'],
  [12009, 23031, 'EPSG', 'ED50 / UTM zone 31N'],
  [12010, 23032, 'EPSG', 'ED50 / UTM zone 32N'],
  [12011, 23033, 'EPSG', 'ED50 / UTM zone 33N'],
  [12012, 23034, 'EPSG', 'ED50 / UTM zone 34N'],
  [12013, 23035, 'EPSG', 'ED50 / UTM zone 35N'],
  [12014, 23036, 'EPSG', 'ED50 / UTM zone 36N'],
  [13001, 6124, 'EPSG', 'WGS 84 / EPSG Arctic zone 4-12'],
  [13002, 3006, 'EPSG', 'SWEREF99 TM'],
  [13003, 3007, 'EPSG', 'SWEREF99 12 00'],
  [13004, 3008, 'EPSG', 'SWEREF99 13 30'],
  [13005, 3009, 'EPSG', 'SWEREF99 15 00'],
  [13006, 3010, 'EPSG', 'SWEREF99 16 30'],
  [13007, 3011, 'EPSG', 'SWEREF99 18 00'],
  [13008, 3012, 'EPSG', 'SWEREF99 14 15'],
  [13009, 3013, 'EPSG', 'SWEREF99 15 45'],
  [13010, 3014, 'EPSG', 'SWEREF99 17 15'],
  [13011, 3015, 'EPSG', 'SWEREF99 18 45'],
  [13012, 3016, 'EPSG', 'SWEREF99 20 15'],
  [13013, 3017, 'EPSG', 'SWEREF99 21 45'],
  [13014, 3018, 'EPSG', 'SWEREF99 23 15'],
  [14001, 21781, 'EPSG', 'CH1903 / LV03'],
  [14002, 2056, 'EPSG', 'CH1903+ / LV95'],
  [15001, 3912, 'EPSG', 'MGI 1901 / Slovene National Grid'],
  [15002, 3794, 'EPSG', 'Slovenia 1996 / Slovene National Grid'],
  [16001, 4685, 'SR', 'ORG;Gauss Boaga Fuso Ovest'],
  [16002, 4686, 'EPSG', 'MAGNA-SIRGAS'],
  [16003, 23031, 'EPSG', 'ED50 / UTM zone 31N'],
  [16004, 23032, 'EPSG', 'ED50 / UTM zone 32N'],
  [16005, 23033, 'EPSG', 'ED50 / UTM zone 33N'],
  [16006, 23034, 'EPSG', 'ED50 / UTM zone 34N'],
  [16007, 25832, 'EPSG', 'ETRS89 / UTM zone 32N'],
  [16008, 25833, 'EPSG', 'ETRS89 / UTM zone 33N'],
  [16009, 6707, 'EPSG', 'RDN2008 / UTM zone 32N (N-E)'],
  [16010, 6708, 'EPSG', 'RDN2008 / UTM zone 33N (N-E)'],
  [16011, 6875, 'EPSG', 'RDN2008 / Italy zone (N-E)'],
  [16012, 6876, 'EPSG', 'RDN2008 / Zone 12 (N-E)'],
  [17001, 2206, 'EPSG', 'ED50 / 3-degree Gauss-Kruger zone 9'],
  [17002, 2207, 'EPSG', 'ED50 / 3-degree Gauss-Kruger zone 10'],
  [17003, 2208, 'EPSG', 'ED50 / 3-degree Gauss-Kruger zone 11'],
  [17004, 2209, 'EPSG', 'ED50 / 3-degree Gauss-Kruger zone 12'],
  [17005, 2210, 'EPSG', 'ED50 / 3-degree Gauss-Kruger zone 13'],
  [17006, 2211, 'EPSG', 'ED50 / 3-degree Gauss-Kruger zone 14'],
  [17007, 2212, 'EPSG', 'ED50 / 3-degree Gauss-Kruger zone 15'],
  [17008, 7006, 'EPSG', 'Nahrwan 1934 / UTM zone 38N'],
  [18001, 2046, 'EPSG', 'Hartebeesthoek94 / Lo15'],
  [18002, 2047, 'EPSG', 'Hartebeesthoek94 / Lo17'],
  [18003, 2048, 'EPSG', 'Hartebeesthoek94 / Lo19'],
  [18004, 2049, 'EPSG', 'Hartebeesthoek94 / Lo21'],
  [18005, 2050, 'EPSG', 'Hartebeesthoek94 / Lo23'],
  [18006, 2051, 'EPSG', 'Hartebeesthoek94 / Lo25'],
  [18007, 2052, 'EPSG', 'Hartebeesthoek94 / Lo27'],
  [18008, 2053, 'EPSG', 'Hartebeesthoek94 / Lo29'],
  [18009, 2054, 'EPSG', 'Hartebeesthoek94 / Lo31'],
  [18010, 2055, 'EPSG', 'Hartebeesthoek94 / Lo33'],
  [19000, 2193, 'EPSG', 'NZGD2000 / New Zealand Transverse Mercator 2000'],
  [20001, 28348, 'EPSG', 'GDA94 / MGA zone 48'],
  [20002, 28349, 'EPSG', 'GDA94 / MGA zone 49'],
  [20003, 28350, 'EPSG', 'GDA94 / MGA zone 50'],
  [20004, 28351, 'EPSG', 'GDA94 / MGA zone 51'],
  [20005, 28352, 'EPSG', 'GDA94 / MGA zone 52'],
  [20006, 28353, 'EPSG', 'GDA94 / MGA zone 53'],
  [20007, 28354, 'EPSG', 'GDA94 / MGA zone 54'],
  [20008, 28355, 'EPSG', 'GDA94 / MGA zone 55'],
  [20009, 28356, 'EPSG', 'GDA94 / MGA zone 56'],
  [20010, 28357, 'EPSG', 'GDA94 / MGA zone 57'],
  [20011, 28358, 'EPSG', 'GDA94 / MGA zone 58'],
  [20012, 3112, 'EPSG', 'GDA94 / Geoscience Australia Lambert'],
  [21001, 23032, 'EPSG', 'ED50 / UTM zone 32N'],
  [21002, 23033, 'EPSG', 'ED50 / UTM zone 33N'],
  [21003, 25832, 'EPSG', 'ETRS89 / UTM zone 32N'],
  [21004, 25833, 'EPSG', 'ETRS89 / UTM zone 33N'],
  [23001, 0, ';', 'outh Africa rotated WG15;#CRS-Code missing in OCA'],
  [23002, 0, ';', 'outh Africa rotated WG17;#CRS-Code missing in OCA'],
  [23003, 0, ';', 'outh Africa rotated WG19;#CRS-Code missing in OCA'],
  [23004, 0, ';', 'outh Africa rotated WG21;#CRS-Code missing in OCA'],
  [23005, 0, ';', 'outh Africa rotated WG23;#CRS-Code missing in OCA'],
  [23006, 0, ';', 'outh Africa rotated WG25;#CRS-Code missing in OCA'],
  [23007, 0, ';', 'outh Africa rotated WG27;#CRS-Code missing in OCA'],
  [23008, 0, ';', 'outh Africa rotated WG29;#CRS-Code missing in OCA'],
  [23009, 0, ';', 'outh Africa rotated WG31;#CRS-Code missing in OCA'],
  [23010, 0, ';', 'outh Africa rotated WG33;#CRS-Code missing in OCA'],
  [24000, 4272, 'EPSG', 'NZGD49'],
  [26000, 3346, 'EPSG', 'LKS94 / Lithuania TM'],
  [27000, 3301, 'EPSG', 'Estonian Coordinate System of 1997'],
  [28000, 3059, 'EPSG', 'LKS92 / Latvia TM'],
  [29000, 2100, 'EPSG', 'GGRS87 / Greek Grid'],
  [30001, 23028, 'EPSG', 'ED50 / UTM zone 28N'],
  [30002, 23029, 'EPSG', 'ED50 / UTM zone 29N'],
  [30003, 23030, 'EPSG', 'ED50 / UTM zone 30N'],
  [30004, 23030, 'EPSG', 'ED50 / UTM zone 30N'],
  [30005, 23031, 'EPSG', 'ED50 / UTM zone 31N'],
  [30006, 23031, 'EPSG', 'ED50 / UTM zone 31N'],
  [31005, 7009, 'SR', 'ORG;GK 5 Croatia'],
  [31006, 7010, 'SR', 'ORG;GK 6 Croatia'],
  [31007, 3765, 'EPSG', 'HTRS96 / Croatia TM'],
  [32000, 23033, 'EPSG', 'ED50 / UTM zone 33N'],
  [33001, 2169, 'EPSG', 'Luxembourg 1930 / Gauss'],
  [33002, 23031, 'EPSG', 'ED50 / UTM zone 31N'],
  [34000, 29902, 'EPSG', 'TM65 / Irish Grid'],
  [35000, 2462, 'EPSG', 'Albanian 1987 / Gauss-Kruger zone 4'],
  [36001, 25833, 'EPSG', 'ETRS89 / UTM zone 33N'],
  [36002, 25834, 'EPSG', 'ETRS89 / UTM zone 34N'],
  [37001, 25834, 'EPSG', 'ETRS89 / UTM zone 34N'],
  [37002, 25835, 'EPSG', 'ETRS89 / UTM zone 35N'],
  [38001, 0, ';', 'celand UTM HJ1955 26N;#CRS-Code missing in OCA'],
  [38002, 0, ';', 'celand UTM HJ1955 27N;#CRS-Code missing in OCA'],
  [38003, 0, ';', 'celand UTM HJ1955 28N;#CRS-Code missing in OCA'],
  [38004, 3057, 'EPSG', 'ISN93 / Lambert 1993'],
  [39000, 23033, 'EPSG', 'ED50 / UTM zone 33N'],
  [40000, 23032, 'EPSG', 'ED50 / UTM zone 32N'],
  [41001, 28991, 'EPSG', 'Amersfoort / RD Old'],
  [41002, 23031, 'EPSG', 'ED50 / UTM zone 31N'],
  [41003, 23032, 'EPSG', 'ED50 / UTM zone 32N'],
  [41004, 28992, 'EPSG', 'Amersfoort / RD New'],
  [42001, 27493, 'EPSG', 'Datum 73 / Modified Portuguese Grid'],
  [42002, 23028, 'EPSG', 'ED50 / UTM zone 28N'],
  [43001, 0, ';', 'omania S42 34N;#CRS-Code missing in OCA'],
  [43002, 0, ';', 'omania S42 35N;#CRS-Code missing in OCA'],
  [44000, 23033, 'EPSG', 'ED50 / UTM zone 33N'],
  [46001, 5514, 'EPSG', 'S-JTSK / Krovak East North'],
  [
    46002,
    28403,
    'EPSG',
    'Pulkovo 1942 / Gauss-Kruger zone 3;#Deprecated: Change of base CRS. Use EPSG:3333 instead',
  ],
  [47001, 5514, 'EPSG', 'S-JTSK / Krovak East North'],
  [
    47002,
    28403,
    'EPSG',
    'Pulkovo 1942 / Gauss-Kruger zone 3;#Deprecated: Change of base CRS. Use EPSG:3333 instead',
  ],
  [47003, 28404, 'EPSG', 'Pulkovo 1942 / Gauss-Kruger zone 4'],
  [48001, 2180, 'EPSG', 'ETRS89 / Poland CS92'],
  [48002, 2176, 'EPSG', 'ETRS89 / Poland CS2000 zone 5'],
  [48003, 2177, 'EPSG', 'ETRS89 / Poland CS2000 zone 6'],
  [48004, 2178, 'EPSG', 'ETRS89 / Poland CS2000 zone 7'],
  [48005, 2179, 'EPSG', 'ETRS89 / Poland CS2000 zone 8'],
  [49000, 23700, 'EPSG', 'HD72 / EOV'],
  [50001, 26929, 'EPSG', 'NAD83 / Alabama East'],
  [50002, 26930, 'EPSG', 'NAD83 / Alabama West'],
  [50004, 26932, 'EPSG', 'NAD83 / Alaska zone 2'],
  [50005, 26933, 'EPSG', 'NAD83 / Alaska zone 3'],
  [50006, 26934, 'EPSG', 'NAD83 / Alaska zone 4'],
  [50007, 26935, 'EPSG', 'NAD83 / Alaska zone 5'],
  [50008, 26936, 'EPSG', 'NAD83 / Alaska zone 6'],
  [50009, 26937, 'EPSG', 'NAD83 / Alaska zone 7'],
  [50010, 26938, 'EPSG', 'NAD83 / Alaska zone 8'],
  [50011, 26939, 'EPSG', 'NAD83 / Alaska zone 9'],
  [50012, 26940, 'EPSG', 'NAD83 / Alaska zone 10'],
  [50013, 26948, 'EPSG', 'NAD83 / Arizona East'],
  [50014, 26949, 'EPSG', 'NAD83 / Arizona Central'],
  [50015, 26950, 'EPSG', 'NAD83 / Arizona West'],
  [50016, 26951, 'EPSG', 'NAD83 / Arkansas North'],
  [50017, 26952, 'EPSG', 'NAD83 / Arkansas South'],
  [50018, 26941, 'EPSG', 'NAD83 / California zone 1'],
  [50019, 26942, 'EPSG', 'NAD83 / California zone 2'],
  [50020, 26943, 'EPSG', 'NAD83 / California zone 3'],
  [50021, 26944, 'EPSG', 'NAD83 / California zone 4'],
  [50022, 26945, 'EPSG', 'NAD83 / California zone 5'],
  [50023, 26946, 'EPSG', 'NAD83 / California zone 6'],
  [50024, 26953, 'EPSG', 'NAD83 / Colorado North'],
  [50025, 26954, 'EPSG', 'NAD83 / Colorado Central'],
  [50026, 26955, 'EPSG', 'NAD83 / Colorado South'],
  [50027, 26956, 'EPSG', 'NAD83 / Connecticut'],
  [50028, 26957, 'EPSG', 'NAD83 / Delaware'],
  [50029, 26958, 'EPSG', 'NAD83 / Florida East'],
  [50030, 26959, 'EPSG', 'NAD83 / Florida West'],
  [50031, 26960, 'EPSG', 'NAD83 / Florida North'],
  [50032, 26966, 'EPSG', 'NAD83 / Georgia East'],
  [50033, 26967, 'EPSG', 'NAD83 / Georgia West'],
  [50034, 26961, 'EPSG', 'NAD83 / Hawaii zone 1'],
  [50035, 26962, 'EPSG', 'NAD83 / Hawaii zone 2'],
  [50036, 26963, 'EPSG', 'NAD83 / Hawaii zone 3'],
  [50037, 26964, 'EPSG', 'NAD83 / Hawaii zone 4'],
  [50038, 26965, 'EPSG', 'NAD83 / Hawaii zone 5'],
  [50039, 26968, 'EPSG', 'NAD83 / Idaho East'],
  [50040, 26969, 'EPSG', 'NAD83 / Idaho Central'],
  [50041, 26970, 'EPSG', 'NAD83 / Idaho West'],
  [50042, 26971, 'EPSG', 'NAD83 / Illinois East'],
  [50043, 26972, 'EPSG', 'NAD83 / Illinois West'],
  [50044, 26973, 'EPSG', 'NAD83 / Indiana East'],
  [50045, 26974, 'EPSG', 'NAD83 / Indiana West'],
  [50046, 26975, 'EPSG', 'NAD83 / Iowa North'],
  [50047, 26976, 'EPSG', 'NAD83 / Iowa South'],
  [50048, 26977, 'EPSG', 'NAD83 / Kansas North'],
  [50049, 26978, 'EPSG', 'NAD83 / Kansas South'],
  [
    50050,
    26979,
    'EPSG',
    'NAD83 / Kentucky North;#Deprecated: Deprecation of constituent map projection 14100 which was in error. Use EPSG:2205 instead',
  ],
  [50051, 26980, 'EPSG', 'NAD83 / Kentucky South'],
  [50052, 26981, 'EPSG', 'NAD83 / Louisiana North'],
  [50053, 26982, 'EPSG', 'NAD83 / Louisiana South'],
  [50054, 32199, 'EPSG', 'NAD83 / Louisiana Offshore'],
  [50055, 26983, 'EPSG', 'NAD83 / Maine East'],
  [50056, 26984, 'EPSG', 'NAD83 / Maine West'],
  [50057, 26985, 'EPSG', 'NAD83 / Maryland'],
  [50058, 26986, 'EPSG', 'NAD83 / Massachusetts Mainland'],
  [50059, 26987, 'EPSG', 'NAD83 / Massachusetts Island'],
  [50060, 26988, 'EPSG', 'NAD83 / Michigan North'],
  [50061, 26989, 'EPSG', 'NAD83 / Michigan Central'],
  [50062, 26990, 'EPSG', 'NAD83 / Michigan South'],
  [50063, 26991, 'EPSG', 'NAD83 / Minnesota North'],
  [50064, 26992, 'EPSG', 'NAD83 / Minnesota Central'],
  [50065, 26993, 'EPSG', 'NAD83 / Minnesota South'],
  [50066, 26994, 'EPSG', 'NAD83 / Mississippi East'],
  [50067, 26995, 'EPSG', 'NAD83 / Mississippi West'],
  [50068, 26996, 'EPSG', 'NAD83 / Missouri East'],
  [50069, 26997, 'EPSG', 'NAD83 / Missouri Central'],
  [50070, 26998, 'EPSG', 'NAD83 / Missouri West'],
  [50071, 32100, 'EPSG', 'NAD83 / Montana'],
  [50072, 32104, 'EPSG', 'NAD83 / Nebraska'],
  [50073, 32107, 'EPSG', 'NAD83 / Nevada East'],
  [50074, 32108, 'EPSG', 'NAD83 / Nevada Central'],
  [50075, 32109, 'EPSG', 'NAD83 / Nevada West'],
  [50076, 32110, 'EPSG', 'NAD83 / New Hampshire'],
  [50077, 32111, 'EPSG', 'NAD83 / New Jersey'],
  [50078, 32112, 'EPSG', 'NAD83 / New Mexico East'],
  [50079, 32113, 'EPSG', 'NAD83 / New Mexico Central'],
  [50080, 32114, 'EPSG', 'NAD83 / New Mexico West'],
  [50081, 32115, 'EPSG', 'NAD83 / New York East'],
  [50082, 32116, 'EPSG', 'NAD83 / New York Central'],
  [50083, 32117, 'EPSG', 'NAD83 / New York West'],
  [50084, 32118, 'EPSG', 'NAD83 / New York Long Island'],
  [50085, 32119, 'EPSG', 'NAD83 / North Carolina'],
  [50086, 32120, 'EPSG', 'NAD83 / North Dakota North'],
  [50087, 32121, 'EPSG', 'NAD83 / North Dakota South'],
  [50088, 32122, 'EPSG', 'NAD83 / Ohio North'],
  [50089, 32123, 'EPSG', 'NAD83 / Ohio South'],
  [50090, 32124, 'EPSG', 'NAD83 / Oklahoma North'],
  [50091, 32125, 'EPSG', 'NAD83 / Oklahoma South'],
  [50092, 32126, 'EPSG', 'NAD83 / Oregon North'],
  [50093, 32127, 'EPSG', 'NAD83 / Oregon South'],
  [50094, 32128, 'EPSG', 'NAD83 / Pennsylvania North'],
  [50095, 32129, 'EPSG', 'NAD83 / Pennsylvania South'],
  [50096, 32130, 'EPSG', 'NAD83 / Rhode Island'],
  [50097, 32133, 'EPSG', 'NAD83 / South Carolina'],
  [50098, 32134, 'EPSG', 'NAD83 / South Dakota North'],
  [50099, 32135, 'EPSG', 'NAD83 / South Dakota South'],
  [50100, 32136, 'EPSG', 'NAD83 / Tennessee'],
  [50101, 32137, 'EPSG', 'NAD83 / Texas North'],
  [50102, 32138, 'EPSG', 'NAD83 / Texas North Central'],
  [50103, 32139, 'EPSG', 'NAD83 / Texas Central'],
  [50104, 32140, 'EPSG', 'NAD83 / Texas South Central'],
  [50105, 32141, 'EPSG', 'NAD83 / Texas South'],
  [50106, 32142, 'EPSG', 'NAD83 / Utah North'],
  [50107, 32143, 'EPSG', 'NAD83 / Utah Central'],
  [50108, 32144, 'EPSG', 'NAD83 / Utah South'],
  [50109, 32145, 'EPSG', 'NAD83 / Vermont'],
  [50110, 32146, 'EPSG', 'NAD83 / Virginia North'],
  [50111, 32147, 'EPSG', 'NAD83 / Virginia South'],
  [50112, 32148, 'EPSG', 'NAD83 / Washington North'],
  [50113, 32149, 'EPSG', 'NAD83 / Washington South'],
  [50114, 32150, 'EPSG', 'NAD83 / West Virginia North'],
  [50115, 32151, 'EPSG', 'NAD83 / West Virginia South'],
  [50116, 32152, 'EPSG', 'NAD83 / Wisconsin North'],
  [50117, 32153, 'EPSG', 'NAD83 / Wisconsin Central'],
  [50118, 32154, 'EPSG', 'NAD83 / Wisconsin South'],
  [50119, 32155, 'EPSG', 'NAD83 / Wyoming East'],
  [50120, 32156, 'EPSG', 'NAD83 / Wyoming East Central'],
  [50121, 32157, 'EPSG', 'NAD83 / Wyoming West Central'],
  [50122, 32158, 'EPSG', 'NAD83 / Wyoming West'],
  [50123, 32158, 'EPSG', 'NAD83 / Wyoming West'],
  [51000, 0, ';', 'abon Datum GRS_1980;#CRS-Code missing in OCA'],
  [52001, 0, ';', 'razil UTM Corrego Alegre Fuso 18;#CRS-Code missing in OCA'],
  [52002, 0, ';', 'razil UTM Corrego Alegre Fuso 19;#CRS-Code missing in OCA'],
  [52003, 0, ';', 'razil UTM Corrego Alegre Fuso 20;#CRS-Code missing in OCA'],
  [52004, 22521, 'EPSG', 'Corrego Alegre 1970-72 / UTM zone 21S'],
  [52005, 22522, 'EPSG', 'Corrego Alegre 1970-72 / UTM zone 22S'],
  [52006, 22523, 'EPSG', 'Corrego Alegre 1970-72 / UTM zone 23S'],
  [52007, 22524, 'EPSG', 'Corrego Alegre 1970-72 / UTM zone 24S'],
  [52008, 22525, 'EPSG', 'Corrego Alegre 1970-72 / UTM zone 25S'],
  [52009, 0, ';', 'razil UTM SAD69 Fuso 18;#CRS-Code missing in OCA'],
  [52010, 0, ';', 'razil UTM SAD69 Fuso 19;#CRS-Code missing in OCA'],
  [52011, 0, ';', 'razil UTM SAD69 Fuso 20;#CRS-Code missing in OCA'],
  [52012, 0, ';', 'razil UTM SAD69 Fuso 21;#CRS-Code missing in OCA'],
  [52013, 0, ';', 'razil UTM SAD69 Fuso 22;#CRS-Code missing in OCA'],
  [52014, 0, ';', 'razil UTM SAD69 Fuso 23;#CRS-Code missing in OCA'],
  [52015, 0, ';', 'razil UTM SAD69 Fuso 24;#CRS-Code missing in OCA'],
  [52016, 0, ';', 'razil UTM SAD69 Fuso 25;#CRS-Code missing in OCA'],
  [52017, 31978, 'EPSG', 'SIRGAS 2000 / UTM zone 18S'],
  [52018, 31979, 'EPSG', 'SIRGAS 2000 / UTM zone 19S'],
  [52019, 31980, 'EPSG', 'SIRGAS 2000 / UTM zone 20S'],
  [52020, 31981, 'EPSG', 'SIRGAS 2000 / UTM zone 21S'],
  [52021, 31982, 'EPSG', 'SIRGAS 2000 / UTM zone 22S'],
  [52022, 31983, 'EPSG', 'SIRGAS 2000 / UTM zone 23S'],
  [52023, 31984, 'EPSG', 'SIRGAS 2000 / UTM zone 24S'],
  [52024, 31985, 'EPSG', 'SIRGAS 2000 / UTM zone 25S'],
  [53000, 2039, 'EPSG', 'Israel 1993 / Israeli TM Grid'],
  [54001, 3375, 'EPSG', 'GDM2000 / Peninsula RSO'],
  [54002, 3376, 'EPSG', 'GDM2000 / East Malaysia BRSO'],
  [55000, 0, ';', 'serDefined Lambert;#CRS-Code missing in OCA'],
  [56000, 3857, 'EPSG', 'WGS 84 / Pseudo-Mercator;#OpenLayers:90091'],
  [57000, 2041, 'EPSG', 'Abidjan 1987 / UTM zone 30N'],
  [58001, 0, ';', 'ri Lanka Datum 1999;#CRS-Code missing in OCA'],
  [58002, 0, ';', 'ri Lanka Datum 1999;#CRS-Code missing in OCA'],
  [60000, 0, ';', 'serDefined;#CRS-Code missing in OCA'],
  [61000, 2326, 'EPSG', 'Hong Kong 1980 Grid System'],
  [62001, 26901, 'EPSG', 'NAD83 / UTM zone 1N'],
  [62002, 26902, 'EPSG', 'NAD83 / UTM zone 2N'],
  [62004, 26903, 'EPSG', 'NAD83 / UTM zone 3N'],
  [62005, 26904, 'EPSG', 'NAD83 / UTM zone 4N'],
  [62006, 26905, 'EPSG', 'NAD83 / UTM zone 5N'],
  [62007, 26906, 'EPSG', 'NAD83 / UTM zone 6N'],
  [62008, 26907, 'EPSG', 'NAD83 / UTM zone 7N'],
  [62009, 26908, 'EPSG', 'NAD83 / UTM zone 8N'],
  [62010, 26909, 'EPSG', 'NAD83 / UTM zone 9N'],
  [62011, 26910, 'EPSG', 'NAD83 / UTM zone 10N'],
  [62012, 26911, 'EPSG', 'NAD83 / UTM zone 11N'],
  [62013, 26912, 'EPSG', 'NAD83 / UTM zone 12N'],
  [62014, 26913, 'EPSG', 'NAD83 / UTM zone 13N'],
  [62015, 26914, 'EPSG', 'NAD83 / UTM zone 14N'],
  [62016, 26915, 'EPSG', 'NAD83 / UTM zone 15N'],
  [62017, 26916, 'EPSG', 'NAD83 / UTM zone 16N'],
  [62018, 26917, 'EPSG', 'NAD83 / UTM zone 17N'],
  [62019, 26918, 'EPSG', 'NAD83 / UTM zone 18N'],
  [62020, 26919, 'EPSG', 'NAD83 / UTM zone 19N'],
  [62021, 26920, 'EPSG', 'NAD83 / UTM zone 20N'],
  [62022, 26921, 'EPSG', 'NAD83 / UTM zone 21N'],
  [62023, 26922, 'EPSG', 'NAD83 / UTM zone 22N'],
  [62024, 26923, 'EPSG', 'NAD83 / UTM zone 23N'],
  [63001, 25828, 'EPSG', 'ETRS89 / UTM zone 28N'],
  [63002, 25829, 'EPSG', 'ETRS89 / UTM zone 29N'],
  [63003, 25830, 'EPSG', 'ETRS89 / UTM zone 30N'],
  [63004, 25831, 'EPSG', 'ETRS89 / UTM zone 31N'],
  [63005, 25832, 'EPSG', 'ETRS89 / UTM zone 32N'],
  [63006, 25833, 'EPSG', 'ETRS89 / UTM zone 33N'],
  [63007, 25834, 'EPSG', 'ETRS89 / UTM zone 34N'],
  [63008, 25835, 'EPSG', 'ETRS89 / UTM zone 35N'],
  [63009, 25836, 'EPSG', 'ETRS89 / UTM zone 36N'],
  [63010, 25837, 'EPSG', 'ETRS89 / UTM zone 37N'],
  [63011, 25838, 'EPSG', 'ETRS89 / UTM zone 38N'],
  [64000, 3785, 'EPSG', 'Popular Visualisation CRS / Mercator'],
  [65000, 3857, 'EPSG', 'WGS 84 / Pseudo-Mercator'],
  [66001, 102629, 'ESRI', 'NAD 1983 StatePlane Alabama East FIPS 0101 Feet'],
  [66002, 102630, 'ESRI', 'NAD 1983 StatePlane Alabama West FIPS 0102 Feet'],
  [66013, 2222, 'EPSG', 'NAD83 / Arizona East (ft)'],
  [66014, 2223, 'EPSG', 'NAD83 / Arizona Central (ft)'],
  [66015, 2224, 'EPSG', 'NAD83 / Arizona West (ft)'],
  [66016, 3433, 'EPSG', 'NAD83 / Arkansas North (ftUS)'],
  [66017, 3434, 'EPSG', 'NAD83 / Arkansas South (ftUS)'],
  [66018, 2225, 'EPSG', 'NAD83 / California zone 1 (ftUS)'],
  [66019, 2226, 'EPSG', 'NAD83 / California zone 2 (ftUS)'],
  [66020, 2227, 'EPSG', 'NAD83 / California zone 3 (ftUS)'],
  [66021, 2228, 'EPSG', 'NAD83 / California zone 4 (ftUS)'],
  [66022, 2229, 'EPSG', 'NAD83 / California zone 5 (ftUS)'],
  [66023, 2230, 'EPSG', 'NAD83 / California zone 6 (ftUS)'],
  [66024, 2231, 'EPSG', 'NAD83 / Colorado North (ftUS)'],
  [66025, 2232, 'EPSG', 'NAD83 / Colorado Central (ftUS)'],
  [66026, 2233, 'EPSG', 'NAD83 / Colorado South (ftUS)'],
  [66027, 2234, 'EPSG', 'NAD83 / Connecticut (ftUS)'],
  [66028, 2235, 'EPSG', 'NAD83 / Delaware (ftUS)'],
  [66029, 2236, 'EPSG', 'NAD83 / Florida East (ftUS)'],
  [66030, 2237, 'EPSG', 'NAD83 / Florida West (ftUS)'],
  [66031, 2238, 'EPSG', 'NAD83 / Florida North (ftUS)'],
  [66032, 2239, 'EPSG', 'NAD83 / Georgia East (ftUS)'],
  [66033, 2240, 'EPSG', 'NAD83 / Georgia West (ftUS)'],
  [66036, 3759, 'EPSG', 'NAD83 / Hawaii zone 3 (ftUS)'],
  [66039, 2241, 'EPSG', 'NAD83 / Idaho East (ftUS)'],
  [66040, 2242, 'EPSG', 'NAD83 / Idaho Central (ftUS)'],
  [66041, 2243, 'EPSG', 'NAD83 / Idaho West (ftUS)'],
  [66042, 3435, 'EPSG', 'NAD83 / Illinois East (ftUS)'],
  [66043, 3436, 'EPSG', 'NAD83 / Illinois West (ftUS)'],
  [
    66044,
    2244,
    'EPSG',
    'NAD83 / Indiana East (ftUS);#Deprecated: Constituent projection deprecated. Use EPSG:2965 instead',
  ],
  [
    66045,
    2245,
    'EPSG',
    'NAD83 / Indiana West (ftUS);#Deprecated: Constituent projection deprecated. Use EPSG:2966 instead',
  ],
  [66046, 3417, 'EPSG', 'NAD83 / Iowa North (ftUS)'],
  [66047, 3418, 'EPSG', 'NAD83 / Iowa South (ftUS)'],
  [66048, 3419, 'EPSG', 'NAD83 / Kansas North (ftUS)'],
  [66049, 3420, 'EPSG', 'NAD83 / Kansas South (ftUS)'],
  [66050, 2246, 'EPSG', 'NAD83 / Kentucky North (ftUS)'],
  [66051, 2247, 'EPSG', 'NAD83 / Kentucky South (ftUS)'],
  [66052, 3451, 'EPSG', 'NAD83 / Louisiana North (ftUS)'],
  [66053, 3452, 'EPSG', 'NAD83 / Louisiana South (ftUS)'],
  [66054, 3453, 'EPSG', 'NAD83 / Louisiana Offshore (ftUS)'],
  [66055, 26847, 'EPSG', 'NAD83 / Maine East (ftUS)'],
  [66056, 26848, 'EPSG', 'NAD83 / Maine West (ftUS)'],
  [66057, 2248, 'EPSG', 'NAD83 / Maryland (ftUS)'],
  [66058, 2249, 'EPSG', 'NAD83 / Massachusetts Mainland (ftUS)'],
  [66059, 2250, 'EPSG', 'NAD83 / Massachusetts Island (ftUS)'],
  [66060, 2251, 'EPSG', 'NAD83 / Michigan North (ft)'],
  [66061, 2252, 'EPSG', 'NAD83 / Michigan Central (ft)'],
  [66062, 2253, 'EPSG', 'NAD83 / Michigan South (ft)'],
  [66063, 26849, 'EPSG', 'NAD83 / Minnesota North (ftUS)'],
  [66064, 26850, 'EPSG', 'NAD83 / Minnesota Central (ftUS)'],
  [66065, 26851, 'EPSG', 'NAD83 / Minnesota South (ftUS)'],
  [66066, 2254, 'EPSG', 'NAD83 / Mississippi East (ftUS)'],
  [66067, 2255, 'EPSG', 'NAD83 / Mississippi West (ftUS)'],
  [66068, 102696, 'ESRI', 'NAD 1983 StatePlane Missouri East FIPS 2401 Feet'],
  [
    66069,
    102697,
    'ESRI',
    'NAD 1983 StatePlane Missouri Central FIPS 2402 Feet',
  ],
  [66070, 102698, 'ESRI', 'NAD 1983 StatePlane Missouri West FIPS 2403 Feet'],
  [66071, 2256, 'EPSG', 'NAD83 / Montana (ft)'],
  [66072, 26852, 'EPSG', 'NAD83 / Nebraska (ftUS)'],
  [66073, 3421, 'EPSG', 'NAD83 / Nevada East (ftUS)'],
  [66074, 3422, 'EPSG', 'NAD83 / Nevada Central (ftUS)'],
  [66075, 3423, 'EPSG', 'NAD83 / Nevada West (ftUS)'],
  [66076, 3437, 'EPSG', 'NAD83 / New Hampshire (ftUS)'],
  [66077, 3424, 'EPSG', 'NAD83 / New Jersey (ftUS)'],
  [66078, 2257, 'EPSG', 'NAD83 / New Mexico East (ftUS)'],
  [66079, 2258, 'EPSG', 'NAD83 / New Mexico Central (ftUS)'],
  [66080, 2259, 'EPSG', 'NAD83 / New Mexico West (ftUS)'],
  [66081, 2260, 'EPSG', 'NAD83 / New York East (ftUS)'],
  [66082, 2261, 'EPSG', 'NAD83 / New York Central (ftUS)'],
  [66083, 2262, 'EPSG', 'NAD83 / New York West (ftUS)'],
  [66084, 2263, 'EPSG', 'NAD83 / New York Long Island (ftUS)'],
  [66085, 2264, 'EPSG', 'NAD83 / North Carolina (ftUS)'],
  [66086, 2265, 'EPSG', 'NAD83 / North Dakota North (ft)'],
  [66087, 2266, 'EPSG', 'NAD83 / North Dakota South (ft)'],
  [66088, 3734, 'EPSG', 'NAD83 / Ohio North (ftUS)'],
  [66089, 3735, 'EPSG', 'NAD83 / Ohio South (ftUS)'],
  [66090, 2267, 'EPSG', 'NAD83 / Oklahoma North (ftUS)'],
  [66091, 2268, 'EPSG', 'NAD83 / Oklahoma South (ftUS)'],
  [66092, 2269, 'EPSG', 'NAD83 / Oregon North (ft)'],
  [66093, 2270, 'EPSG', 'NAD83 / Oregon South (ft)'],
  [66094, 2271, 'EPSG', 'NAD83 / Pennsylvania North (ftUS)'],
  [66095, 2272, 'EPSG', 'NAD83 / Pennsylvania South (ftUS)'],
  [66096, 3438, 'EPSG', 'NAD83 / Rhode Island (ftUS)'],
  [66097, 2273, 'EPSG', 'NAD83 / South Carolina (ft)'],
  [66098, 3454, 'EPSG', 'NAD83 / South Dakota North (ftUS)'],
  [66099, 3455, 'EPSG', 'NAD83 / South Dakota South (ftUS)'],
  [66100, 2274, 'EPSG', 'NAD83 / Tennessee (ftUS)'],
  [66101, 2275, 'EPSG', 'NAD83 / Texas North (ftUS)'],
  [66102, 2276, 'EPSG', 'NAD83 / Texas North Central (ftUS)'],
  [66103, 2277, 'EPSG', 'NAD83 / Texas Central (ftUS)'],
  [66104, 2278, 'EPSG', 'NAD83 / Texas South Central (ftUS)'],
  [66105, 2279, 'EPSG', 'NAD83 / Texas South (ftUS)'],
  [66106, 3560, 'EPSG', 'NAD83 / Utah North (ftUS)'],
  [66107, 3566, 'EPSG', 'NAD83 / Utah Central (ftUS)'],
  [66108, 3567, 'EPSG', 'NAD83 / Utah South (ftUS)'],
  [66109, 102745, 'ESRI', 'NAD 1983 StatePlane Vermont FIPS 4400 Feet'],
  [66110, 2283, 'EPSG', 'NAD83 / Virginia North (ftUS)'],
  [66111, 2284, 'EPSG', 'NAD83 / Virginia South (ftUS)'],
  [66112, 2285, 'EPSG', 'NAD83 / Washington North (ftUS)'],
  [66113, 2286, 'EPSG', 'NAD83 / Washington South (ftUS)'],
  [66114, 26853, 'EPSG', 'NAD83 / West Virginia North (ftUS)'],
  [66115, 26854, 'EPSG', 'NAD83 / West Virginia South (ftUS)'],
  [66116, 2287, 'EPSG', 'NAD83 / Wisconsin North (ftUS)'],
  [66117, 2288, 'EPSG', 'NAD83 / Wisconsin Central (ftUS)'],
  [66118, 2289, 'EPSG', 'NAD83 / Wisconsin South (ftUS)'],
  [66119, 3736, 'EPSG', 'NAD83 / Wyoming East (ftUS)'],
  [66120, 3737, 'EPSG', 'NAD83 / Wyoming East Central (ftUS)'],
  [66121, 3738, 'EPSG', 'NAD83 / Wyoming West Central (ftUS)'],
  [66122, 3739, 'EPSG', 'NAD83 / Wyoming West (ftUS)'],
  [
    66123,
    102761,
    'ESRI',
    'NAD 1983 StatePlane Puerto Rico Virgin Islands FIPS 5200 Feet',
  ],
  [67000, 7392, 'SR', 'ORG;KosovaRef01'],
  [68000, 21037, 'EPSG', 'Arc 1960 / UTM zone 37S'],
  [69000, 2586, 'EPSG', 'Pulkovo 1942 / 3-degree Gauss-Kruger CM 33E'],
  [70000, 2019, 'EPSG', 'NAD27(76) / MTM zone 10'],
]

},{}],23:[function(require,module,exports){
const crsGrids = require('./crs-grids')
const TdPoly = require('./td-poly')

// OCAD uses 1/100 mm of "paper coordinates" as units, we
// want to convert to meters in real world
const hundredsMmToMeter = 1 / (100 * 1000)

module.exports = class Crs {
  /**
   * @type {number}
   */
  easting
  /**
   * @type {number}
   **/
  northing
  /**
   * @type {number}
   **/
  scale
  /**
   * @type {number}
   **/
  gridId
  /**
   * @type {number}
   * @description Grivation in radians
   **/
  grivation
  /**
   * @type {number}
   */
  code
  /**
   * @type {string}
   */
  catalog
  /**
   * @type {string}
   **/
  name

  /**
   * @param {import('./parameter-string').ParameterStringValues} scalePar
   */
  constructor(scalePar) {
    const {
      x: easting,
      y: northing,
      m: scale,
      i: gridId,
      a: grivation,
    } = scalePar

    this.easting = Number(easting)
    this.northing = Number(northing)
    this.scale = Number(scale)
    this.gridId = Number(gridId)
    this.grivation = (Number(grivation) / 180) * Math.PI

    this.grid = crsGrids.find(g => g[0] === this.gridId)
    const [, code, catalog, name] = this.grid || [this.gridId, 0, null, null]
    this.code = code
    this.catalog = catalog
    this.name = name
  }

  /**
   * Converts an OCAD map coordinate (paper coordinates) to
   * a coordinate in this CRS.
   * @param {TdPoly|number[]} coord
   * @returns {TdPoly|number[]} the projected coordinate;
   * if the input is a TdPoly, the output is a TdPoly instance, otherwise just a coordinate array
   */
  toProjectedCoord(coord) {
    coord = rotate(coord, -this.grivation)

    const projected = [
      coord[0] * hundredsMmToMeter * this.scale + this.easting,
      coord[1] * hundredsMmToMeter * this.scale + this.northing,
    ]
    return coord instanceof TdPoly
      ? new TdPoly(projected[0], projected[1], coord.xFlags, coord.yFlags)
      : projected
  }

  /**
   * Converts a coordinate in this CRS to an OCAD map coordinate (paper coordinates).
   * @param {TdPoly|number[]} coord
   * @returns {TdPoly|number[]} the map coordinate;
   * if the input is a TdPoly, the output is a TdPoly instance, otherwise just a coordinate array
   */
  toMapCoord(coord) {
    const map = [
      (coord[0] - this.easting) / hundredsMmToMeter / this.scale,
      (coord[1] - this.northing) / hundredsMmToMeter / this.scale,
    ]
    coord = rotate(coord, this.grivation)
    return coord instanceof TdPoly
      ? new TdPoly(map[0], map[1], coord.xFlags, coord.yFlags)
      : map
  }
}

/**
 * Rotates a coordinate around the origin.
 *
 * @param {number[]|TdPoly} c the coordinate to rotate
 * @param {number} theta rotation angle in radians
 * @returns {number[]|TdPoly} the rotated coordinate;
 * if the input is a TdPoly, the output is a TdPoly instance, otherwise just a coordinate array
 */
function rotate(c, theta) {
  if (c instanceof TdPoly) {
    return c.rotate(theta)
  } else {
    return [
      c[0] * Math.cos(theta) - c[1] * Math.sin(theta),
      c[0] * Math.sin(theta) + c[1] * Math.cos(theta),
    ]
  }
}

},{"./crs-grids":22,"./td-poly":41}],24:[function(require,module,exports){
module.exports = class FileHeader {
  /**
   * @type {number}
   */
  ocadMark
  /**
   * @type {number}
   */
  fileType
  /**
   * @type {number}
   */
  version
  /**
   * @type {number}
   */
  subVersion
  /**
   * @type {number}
   */
  subSubVersion
  /**
   * @type {number}
   */
  symbolIndexBlock
  /**
   * @type {number}
   */
  objectIndexBlock
  /**
   * @type {number}
   */
  offlineSyncSerial
  /**
   * @type {number}
   */
  currentFileVersion
  /**
   * @type {number}
   */
  stringIndexBlock
  /**
   * @type {number}
   */
  fileNamePos
  /**
   * @type {number}
   */
  fileNameSize
  /**
   * @type {number}
   */
  mrStartBlockPosition

  /**
   * @param {import('./buffer-reader')} reader
   */
  constructor(reader) {
    if (reader.buffer.length - reader.offset < 60) {
      throw new Error('Not an OCAD file (not large enough to hold header)')
    }

    this.ocadMark = reader.readSmallInt()
    this.fileType = reader.readByte()
    reader.readByte() // FileStatus, not used
    this.version = reader.readSmallInt()
    this.subVersion = reader.readByte()
    this.subSubVersion = reader.readByte()
    this.symbolIndexBlock = reader.readCardinal()
    this.objectIndexBlock = reader.readCardinal()
    this.offlineSyncSerial = reader.readInteger()
    this.currentFileVersion = reader.readInteger()
    reader.readCardinal() // Internal, not used
    reader.readCardinal() // Internal, not used
    this.stringIndexBlock = reader.readCardinal()
    this.fileNamePos = reader.readCardinal()
    this.fileNameSize = reader.readCardinal()
    reader.readCardinal() // Internal, not used
    reader.readCardinal() // Res1, not used
    reader.readCardinal() // Res2, not used
    this.mrStartBlockPosition = reader.readCardinal()
  }

  /**
   * Tells if this is a valid OCAD file (magic number is correct).
   * @returns {boolean}
   */
  isValid() {
    return this.ocadMark === 0x0cad
  }
}

},{}],25:[function(require,module,exports){
const fs = require('fs')
const { Buffer } = require('buffer')

const FileHeader = require('./file-header')
const SymbolIndex = require('./symbol-index')
const ObjectIndex = require('./object-index')
const StringIndex = require('./string-index')
const BufferReader = require('./buffer-reader')
const InvalidObjectIndexBlockException = require('./invalid-object-index-block-exception')
const OcadFile = require('./ocad-file')

module.exports = readOcad

/**
 * @typedef {Object} ReadOcadOptions
 * @property {boolean=} bypassVersionCheck bypass the version check and read the file anyway
 * @property {boolean=} quietWarnings do not print warnings to console
 * @property {boolean=} failOnWarning throw an error if a warning is encountered
 */

/**
 * Reads an OCAD file from the given path or `Buffer` object into an `OcadFile` object.
 *
 * @param {string|Buffer} path the path of the OCAD file or a binary buffer of the OCAD file contents
 * @param {ReadOcadOptions?} options
 * @returns {Promise<OcadFile>} a promise that resolves to an `OcadFile` object
 */
async function readOcad(path, options = {}) {
  if (Buffer.isBuffer(path)) {
    return parseOcadBuffer(path, options)
  } else {
    const buffer = await new Promise((resolve, reject) =>
      fs.readFile(path, (err, buffer) => {
        if (err) reject(err)

        resolve(buffer)
      })
    )
    return parseOcadBuffer(buffer, options)
  }
}

function parseOcadBuffer(buffer, options) {
  let warnings = []

  const reader = new BufferReader(buffer)
  const header = new FileHeader(reader)
  if (!header.isValid()) {
    throw new Error(
      `Not an OCAD file (invalid header ${header.ocadMark} !== ${0x0cad})`
    )
  }

  if (header.version < 10 && !options.bypassVersionCheck) {
    throw new Error(
      `Unsupport OCAD file version (${header.version}), only >= 10 supported for now.`
    )
  }

  /**
   * @type {import('./symbol-index').Symbol[]}
   */
  const symbols = []
  let symbolIndexOffset = header.symbolIndexBlock
  while (symbolIndexOffset) {
    reader.push(symbolIndexOffset)
    const symbolIndex = new SymbolIndex(reader, header.version, options)
    reader.pop()
    Array.prototype.push.apply(symbols, symbolIndex.parseSymbols(reader))
    warnings = warnings.concat(symbolIndex.warnings)

    symbolIndexOffset = symbolIndex.nextSymbolIndexBlock
  }

  const objects = []
  let objectIndexOffset = header.objectIndexBlock
  let startIndex = 0
  while (objectIndexOffset) {
    reader.push(objectIndexOffset)
    try {
      const objectIndex = new ObjectIndex(reader, startIndex, header.version)
      startIndex += 256
      reader.pop()
      Array.prototype.push.apply(objects, objectIndex.readObjects(reader))

      objectIndexOffset = objectIndex.nextObjectIndexBlock
    } catch (e) {
      if (e instanceof InvalidObjectIndexBlockException) {
        warnings.push(e.toString())
      }
    }
  }

  /**
   * @type {Object.<number, import('./parameter-string').ParameterStringValues[]>}
   */
  const parameterStrings = {}
  let stringIndexOffset = header.stringIndexBlock
  while (stringIndexOffset) {
    reader.push(stringIndexOffset)
    const stringIndex = new StringIndex(reader)
    reader.pop()
    const strings = stringIndex.getStrings(reader)

    for (const recType of Object.keys(strings)) {
      const typeStrings = strings[recType]
      const concatStrings = parameterStrings[recType] || []
      parameterStrings[recType] = concatStrings.concat(
        typeStrings.map(s => s.values)
      )
    }

    stringIndexOffset = stringIndex.nextStringIndexBlock
  }

  if (!options.quietWarnings) {
    warnings.forEach(w => console.warn(w))
  }

  return new OcadFile(header, parameterStrings, objects, symbols, warnings)
}

},{"./buffer-reader":21,"./file-header":24,"./invalid-object-index-block-exception":26,"./object-index":30,"./ocad-file":32,"./string-index":35,"./symbol-index":38,"buffer":16,"fs":13}],26:[function(require,module,exports){
module.exports = class InvalidObjectIndexBlockException extends Error {}

},{}],27:[function(require,module,exports){
module.exports = class InvalidSymbolElementException extends Error {
  constructor(msg, symbolElement) {
    super(msg)
    this.symbolElement = symbolElement
  }
}

},{}],28:[function(require,module,exports){
const { Symbol10, Symbol11 } = require('./symbol')

/**
 * @typedef {import('./symbol-element')} SymbolElement
 */
/**
 * @typedef {import('./symbol').BaseSymbolProps} BaseSymbolProps
 */

/**
 * @typedef {Object} DecreaseDef10
 * @property {number} decMode
 * @property {number} decLast
 * @property {number} res
 */

/**
 * @typedef {Object} DecreaseDef11
 * @property {number} decMode
 * @property {number} decSymbolSize
 * @property {boolean} decSymbolDistance
 * @property {boolean} decSymbolWidth
 * @property {number} decSymbolSize
 */

/**
 * @typedef {DecreaseDef10|Decrease11} DecreaseDef
 */

/**
 * @typedef {object} LineSymbolType
 * @property {2} type
 * @property {number} lineColor
 * @property {number} lineWidth
 * @property {number} lineStyle
 * @property {number} distFromStart
 * @property {number} distToEnd
 * @property {number} mainLength
 * @property {number} endLength
 * @property {number} mainGap
 * @property {number} secGap
 * @property {number} endGap
 * @property {number} minSym
 * @property {number} nPrimSym
 * @property {number} primSymDist

 * @property {BaseDoubleLine} doubleLine
 * @property {DecreaseDef} decrease

 * @property {number} frColor
 * @property {number} frWidth
 * @property {number} frStyle
 * @property {number} primDSize
 * @property {number} secDSize
 * @property {number} cornerDSize
 * @property {number} startDSize
 * @property {number} endDSize
 * @property {number} useSymbolFlags
 * @property {number} reserved

 * @property {SymbolElement[]} primSymElements
 * @property {SymbolElement[]} secSymElements
 * @property {SymbolElement[]} cornerSymElements
 * @property {SymbolElement[]} startSymElements
 * @property {SymbolElement[]} endSymElements
 * 
 * @property {(reader: BufferReader, dataSize: number) => SymbolElement[]} readElements
 * 
 * @typedef {BaseSymbolProps & LineSymbolType} LineSymbol
 * @property {import('./symbol-types').LineSymbolType} type
 */

/** @typedef {import("./buffer-reader")} BufferReader */

/** @implements {LineSymbolType} */
class LineSymbol10 extends Symbol10 {
  /** @type {2} */
  type
  /** @type {number} */
  lineColor
  /** @type {number} */
  lineWidth
  /** @type {number} */
  lineStyle
  /** @type {number} */
  distFromStart
  /** @type {number} */
  distToEnd
  /** @type {number} */
  mainLength
  /** @type {number} */
  endLength
  /** @type {number} */
  mainGap
  /** @type {number} */
  secGap
  /** @type {number} */
  endGap
  /** @type {number} */
  minSym
  /** @type {number} */
  nPrimSym
  /** @type {number} */
  primSymDist
  /** @type {BaseDoubleLine} */
  doubleLine
  /** @type {DecreaseDef} */
  decrease
  /** @type {number} */
  frColor
  /** @type {number} */
  frWidth
  /** @type {number} */
  frStyle
  /** @type {number} */
  primDSize
  /** @type {number} */
  secDSize
  /** @type {number} */
  cornerDSize
  /** @type {number} */
  startDSize
  /** @type {number} */
  endDSize
  /** @type {number} */
  useSymbolFlags
  /** @type {number} */
  reserved
  /** @type {SymbolElement[]} */
  primSymElements
  /** @type {SymbolElement[]} */
  secSymElements
  /** @type {SymbolElement[]} */
  cornerSymElements
  /** @type {SymbolElement[]} */
  startSymElements
  /** @type {SymbolElement[]} */
  endSymElements

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    readLineSymbol(this, reader, DoubleLine10, Decrease10)
  }
}

/** @implements {LineSymbolType} */
class LineSymbol11 extends Symbol11 {
  /** @type {2} */
  type
  /** @type {number} */
  lineColor
  /** @type {number} */
  lineWidth
  /** @type {number} */
  lineStyle
  /** @type {number} */
  distFromStart
  /** @type {number} */
  distToEnd
  /** @type {number} */
  mainLength
  /** @type {number} */
  endLength
  /** @type {number} */
  mainGap
  /** @type {number} */
  secGap
  /** @type {number} */
  endGap
  /** @type {number} */
  minSym
  /** @type {number} */
  nPrimSym
  /** @type {number} */
  primSymDist
  /** @type {BaseDoubleLine} */
  doubleLine
  /** @type {DecreaseDef} */
  decrease
  /** @type {number} */
  frColor
  /** @type {number} */
  frWidth
  /** @type {number} */
  frStyle
  /** @type {number} */
  primDSize
  /** @type {number} */
  secDSize
  /** @type {number} */
  cornerDSize
  /** @type {number} */
  startDSize
  /** @type {number} */
  endDSize
  /** @type {number} */
  useSymbolFlags
  /** @type {number} */
  reserved
  /** @type {SymbolElement[]} */
  primSymElements
  /** @type {SymbolElement[]} */
  secSymElements
  /** @type {SymbolElement[]} */
  cornerSymElements
  /** @type {SymbolElement[]} */
  startSymElements
  /** @type {SymbolElement[]} */
  endSymElements

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    // TODO: why?
    reader.skip(64)

    readLineSymbol(this, reader, DoubleLine11, Decrease11)
  }
}

class BaseDoubleLine {
  /** @type {number} */
  dblMode
  /** @type {number} */
  dblFlags
  /** @type {number} */
  dblFillColor
  /** @type {number} */
  dblLeftColor
  /** @type {number} */
  dblRightColor
  /** @type {number} */
  dblWidth
  /** @type {number} */
  dblLeftWidth
  /** @type {number} */
  dblRightWidth
  /** @type {number} */
  dblLength
  /** @type {number} */
  dblGap

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    this.dblMode = reader.readWord()
    this.dblFlags = reader.readWord()
    this.dblFillColor = reader.readSmallInt()
    this.dblLeftColor = reader.readSmallInt()
    this.dblRightColor = reader.readSmallInt()
    this.dblWidth = reader.readSmallInt()
    this.dblLeftWidth = reader.readSmallInt()
    this.dblRightWidth = reader.readSmallInt()
    this.dblLength = reader.readSmallInt()
    this.dblGap = reader.readSmallInt()
  }
}

class DoubleLine10 extends BaseDoubleLine {
  /** @type {number[]} */
  dblRes

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)
    this.dblRes = new Array(3)
    for (let i = 0; i < this.dblRes.length; i++) {
      this.dblRes[i] = reader.readSmallInt()
    }
  }
}

class DoubleLine11 extends BaseDoubleLine {
  /** @type {number[]} */
  dblRes

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    this.dblBackgroundColor = reader.readSmallInt()
    this.dblRes = new Array(2)
    for (let i = 0; i < this.dblRes.length; i++) {
      this.dblRes[i] = reader.readSmallInt()
    }
  }
}

class Decrease10 {
  /** @type {number} */
  decMode
  /** @type {number} */
  decLast
  /** @type {number} */
  res

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    this.decMode = reader.readWord()
    this.decLast = reader.readWord()
    this.res = reader.readWord()
  }
}

class Decrease11 {
  /** @type {number} */
  decMode
  /** @type {number} */
  decSymbolSize
  /** @type {boolean} */
  decSymbolDistance
  /** @type {boolean} */
  decSymbolWidth

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    this.decMode = reader.readWord()
    this.decSymbolSize = reader.readSmallInt()
    this.decSymbolDistance = !!reader.readByte()
    this.decSymbolWidth = !!reader.readByte()
  }
}

/**
 * @param {LineSymbol} symbol
 * @param {BufferReader} reader
 * @param {typeof DoubleLine10 | typeof DoubleLine11} DoubleLine
 * @param {typeof Decrease10 | typeof Decrease11} Decrease
 */
const readLineSymbol = (symbol, reader, DoubleLine, Decrease) => {
  symbol.type = 2
  symbol.lineColor = reader.readSmallInt()
  symbol.lineWidth = reader.readSmallInt()
  symbol.lineStyle = reader.readSmallInt()
  symbol.distFromStart = reader.readSmallInt()
  symbol.distToEnd = reader.readSmallInt()
  symbol.mainLength = reader.readSmallInt()
  symbol.endLength = reader.readSmallInt()
  symbol.mainGap = reader.readSmallInt()
  symbol.secGap = reader.readSmallInt()
  symbol.endGap = reader.readSmallInt()
  symbol.minSym = reader.readSmallInt()
  symbol.nPrimSym = reader.readSmallInt()
  symbol.primSymDist = reader.readSmallInt()

  symbol.doubleLine = new DoubleLine(reader)
  symbol.decrease = new Decrease(reader)

  symbol.frColor = reader.readSmallInt()
  symbol.frWidth = reader.readSmallInt()
  symbol.frStyle = reader.readSmallInt()
  symbol.primDSize = reader.readWord()
  symbol.secDSize = reader.readWord()
  symbol.cornerDSize = reader.readWord()
  symbol.startDSize = reader.readWord()
  symbol.endDSize = reader.readWord()
  symbol.useSymbolFlags = reader.readByte()
  symbol.reserved = reader.readByte()

  symbol.primSymElements = symbol.readElements(reader, symbol.primDSize)
  symbol.secSymElements = symbol.readElements(reader, symbol.secDSize)
  symbol.cornerSymElements = symbol.readElements(reader, symbol.cornerDSize)
  symbol.startSymElements = symbol.readElements(reader, symbol.startDSize)
  symbol.endSymElements = symbol.readElements(reader, symbol.endDSize)
}

module.exports = {
  10: LineSymbol10,
  11: LineSymbol11,
  12: LineSymbol11,
  2018: LineSymbol11,
}

},{"./symbol":40}],29:[function(require,module,exports){
const TdPoly = require('./td-poly')

module.exports = class LRect {
  /**
   * @type {TdPoly}
   */
  min
  /**
   * @type {TdPoly}
   */
  max

  /**
   * @param {import('./buffer-reader')} reader
   */
  constructor(reader) {
    this.min = new TdPoly(reader.readInteger(), reader.readInteger())
    this.max = new TdPoly(reader.readInteger(), reader.readInteger())
  }
}

},{"./td-poly":41}],30:[function(require,module,exports){
const InvalidObjectIndexBlockException = require('./invalid-object-index-block-exception')
const LRect = require('./lrect')
const TObject = require('./tobject')

/**
 * @typedef {import('./tobject')} TObject
 */

/**
 * @typedef {import('./buffer-reader')} BufferReader
 */

/**
 * @typedef {Object} ObjectIndex
 * @property {LRect} rc
 * @property {number} pos
 * @property {number} len
 * @property {number} sym
 * @property {number} objType
 * @property {number} encryptedMode
 * @property {number} status
 * @property {number} viewType
 * @property {number} color
 * @property {number} group
 * @property {number} impLayer
 * @property {number} dbDatasetHash
 * @property {number} dbKeyHash
 * @property {number} _index
 */

/**
 * @typedef {Object} ObjectIndexBlock
 */
module.exports = class ObjectIndexBlock {
  /** @type {number} */
  version
  /** @type {number} */
  nextObjectIndexBlock
  /** @type {ObjectIndex[]} */
  table

  /**
   * @param {BufferReader} reader
   * @param {number} startIndex
   * @param {number} version
   */
  constructor(reader, startIndex, version) {
    this.version = version

    // Ignore pointers that do not point to a valid location in the file.
    // Compare getBlockCheckedRaw() in Open Orienteering Mapper.
    this.nextObjectIndexBlock = reader.readInteger()
    if (this.nextObjectIndexBlock > reader.buffer.length - (256 * 40 + 4)) {
      throw new InvalidObjectIndexBlockException(
        `Invalid object index block pointer ${this.nextObjectIndexBlock} > ${
          reader.buffer.length - (256 * 40 + 4)
        }.`
      )
    }

    this.table = new Array(256)
    for (let i = 0; i < 256; i++) {
      const rc = new LRect(reader)

      this.table[i] = {
        rc,
        pos: reader.readInteger(),
        len: reader.readInteger(),
        sym: reader.readInteger(),
        objType: reader.readByte(),
        encryptedMode: reader.readByte(),
        status: reader.readByte(),
        viewType: reader.readByte(),
        color: reader.readSmallInt(),
        group: reader.readSmallInt(),
        impLayer: reader.readSmallInt(),
        dbDatasetHash: reader.readByte(),
        dbKeyHash: reader.readByte(),
        _index: startIndex + i,
      }
    }
  }

  /**
   * Reads the objects contained in this object index.
   * @param {BufferReader} reader
   * @returns {TObject[]}
   */
  readObjects(reader) {
    return this.table
      .filter(o => o.status > 0 && o.status < 3) // Remove deleted objects, keep normal and hidden objects.
      .map(o => this.readObject(reader, o))
      .filter(o => o)
  }

  readObject(reader, objIndex) {
    if (!objIndex.pos) return

    reader.push(objIndex.pos)
    const tObject = new TObject[this.version](reader, objIndex)
    reader.pop()
    return tObject
  }
}

},{"./invalid-object-index-block-exception":26,"./lrect":29,"./tobject":43}],31:[function(require,module,exports){
module.exports = {
  PointObjectType: 1,
  LineObjectType: 2,
  AreaObjectType: 3,
  UnformattedTextObjectType: 4,
  FormattedTextObjectType: 5,
  LineTextObjectType: 6,
  RectangleObjectType: 7,
}

},{}],32:[function(require,module,exports){
const getRgb = require('../cmyk-to-rgb')
const Crs = require('./crs')

/** @typedef {import('./file-header')} OcadHeader */
/** @typedef {import('./tobject')} TObject */
/** @typedef {import('./symbol').BaseSymbolDef} Symbol */
/** @typedef {import('./parameter-string')} ParameterString */
/** @typedef {import('./parameter-string').ParameterStringValues} ParameterStringValues */

/**
 * @typedef {Object} Color
 * @property {number} number
 * @property {number[]} cmyk
 * @property {string} name
 * @property {string} rgb
 * @property {number} renderOrder
 * @property {Uint8ClampedArray} rgbArray
 */

module.exports = class OcadFile {
  /**
   * @type {OcadHeader}
   */
  header
  /**
   * @type {Object.<number, ParameterStringValues[]>}
   */
  parameterStrings
  /**
   * @type {TObject[]}
   */
  objects
  /**
   * @type {Symbol[]}
   */
  symbols
  /**
   * @type {string[]}
   */
  warnings
  /**
   * @type {Color[]}
   */
  colors

  /**
   * @param {OcadHeader} header
   * @param {Object.<number, ParameterStringValues[]>} parameterStrings
   * @param {import('./object-index').TObject[]} objects
   * @param {Symbol[]} symbols
   * @param {string[]} warnings
   */
  constructor(header, parameterStrings, objects, symbols, warnings) {
    this.header = header
    this.parameterStrings = parameterStrings
    this.objects = objects
    this.symbols = symbols
    this.warnings = warnings

    this.colors = []
    const colorDefs = parameterStrings[9] || []
    for (let i = 0; i < colorDefs.length; i++) {
      const colorDef = colorDefs[i]
      const cmyk = [
        colorDef.c || 0,
        colorDef.m || 0,
        colorDef.y || 0,
        colorDef.k || 0,
      ].map(Number)
      // @ts-ignore
      const rgb = getRgb(cmyk)
      /**
       * @type {Color}
       */
      const color = {
        number: Number(colorDef.n),
        cmyk,
        name: colorDef._first,
        rgb: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
        renderOrder: i,
        rgbArray: rgb,
      }
      this.colors[Number(color.number)] = color
    }
  }

  getCrs() {
    const scalePar = this.parameterStrings['1039']
      ? this.parameterStrings['1039'][0]
      : { x: '0', y: '0', m: '1', _first: '', _pairs: [] }
    return new Crs(scalePar)
  }

  getBounds(projection = v => v) {
    const bounds = [
      Number.MAX_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ]

    for (const [[x1, y1], [x2, y2]] of this.objects.map(o =>
      Object.values(o.objIndex.rc).map(projection)
    )) {
      bounds[0] = Math.min(x1, x2, bounds[0])
      bounds[1] = Math.min(y1, y2, bounds[1])
      bounds[2] = Math.max(x1, x2, bounds[2])
      bounds[3] = Math.max(y1, y2, bounds[3])
    }

    return bounds
  }
}

},{"../cmyk-to-rgb":18,"./crs":23}],33:[function(require,module,exports){
const { StringDecoder } = require('string_decoder')

const decoder = new StringDecoder('utf8')

/**
 * @typedef {string|string[]} StringIndexValue
 */

/**
 * @typedef {{ _first: string, _pairs: { code: string, value: StringIndexValue }[]}} SourceValues
 */

/** @typedef {import("./buffer-reader")} BufferReader */
/** @typedef {import("./string-index").TStringIndex} TStringIndex */
/**
 * @typedef {{[key: string]: string|string[]} & SourceValues } ParameterStringValues
 */

/**
 * Represents an OCAD parameter string. The string has the following format:
 * ```
 * <first value>\t<code1><value1>\t<code2><value2>\t...
 * ```
 *
 * The values can be accessed through the `values` property. The first value is
 * stored in the `_first` property. The code-value pairs are stored in the
 * `_pairs` property.
 */
module.exports = class ParameterString {
  /**
   * @type {number}
   */
  recType
  /**
   * @type {ParameterStringValues}
   */
  values

  /**
   * @param {BufferReader} reader
   * @param {TStringIndex} indexRecord
   */
  constructor(reader, indexRecord) {
    this.recType = indexRecord.recType

    const offset = reader.offset
    let strLen = 0
    while (reader.readByte()) strLen++
    const val = decoder.end(reader.buffer.subarray(offset, offset + strLen))

    const vals = val.split('\t')
    this.values = { _first: vals[0], _pairs: [] }
    for (let i = 1; i < vals.length; i++) {
      const code = vals[i][0]
      const value = vals[i].substring(1)
      let codeValues = this.values[code]
      if (!codeValues) {
        this.values[code] = value
      } else {
        if (!Array.isArray(codeValues)) {
          codeValues = this.values[code] = [codeValues]
        }
        codeValues.push(value)
      }

      this.values._pairs.push({ code, value })
    }
  }
}

},{"string_decoder":15}],34:[function(require,module,exports){
const { Symbol10, Symbol11 } = require('./symbol')

/**
 * @typedef {import('./buffer-reader')} BufferReader
 */

/**
 * @typedef {object} PointSymbolProps
 * @property {1} type
 * @property {number} dataSize
 */

/** @typedef {import('./symbol').BaseSymbolProps & PointSymbolProps} PointSymbolDef */

/** @implements {PointSymbolDef} */
class PointSymbol10 extends Symbol10 {
  /**
   * @type {1}
   */
  type

  /**
   * @type {number}
   */
  dataSize

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    this.type = 1
    this.dataSize = reader.readWord()
    reader.readSmallInt() // Reserved

    this.elements = this.readElements(reader, this.dataSize)
  }
}

/** @implements {PointSymbolDef} */
class PointSymbol11 extends Symbol11 {
  /**
   * @type {1}
   */
  type

  /**
   * @type {number}
   */
  dataSize

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    // TODO: why?
    reader.skip(64)

    this.type = 1
    this.dataSize = reader.readWord()
    reader.readSmallInt() // Reserved

    this.elements = this.readElements(reader, this.dataSize)
  }
}

module.exports = {
  10: PointSymbol10,
  11: PointSymbol11,
  12: PointSymbol11,
  2018: PointSymbol11,
}

},{"./symbol":40}],35:[function(require,module,exports){
const ParameterString = require('./parameter-string')

/** @typedef {import("./buffer-reader")} BufferReader */

/**
 * @typedef {Object} TStringIndex
 * @property {number} pos
 * @property {number} len
 * @property {number} recType
 * @property {number} objIndex
 */

module.exports = class StringIndexBlock {
  /**
   * @type {number}
   */
  nextStringIndexBlock
  /**
   * @type {TStringIndex[]}
   */
  table

  /**
   * @type {Object.<number, { pos: number, len: number, recType: number, objIndex: number }>}
   */
  constructor(reader) {
    this.nextStringIndexBlock = reader.readInteger()
    this.table = new Array(256)
    for (let i = 0; i < 256; i++) {
      this.table[i] = {
        pos: reader.readInteger(),
        len: reader.readInteger(),
        recType: reader.readInteger(),
        objIndex: reader.readInteger(),
      }
    }
  }

  /**
   * @param {BufferReader} reader
   * @returns {Object.<number, ParameterString[]>}
   */
  getStrings(reader) {
    const strings = this.table
      .filter(si => si.recType > 0)
      .map(si => {
        reader.push(si.pos)
        const s = new ParameterString(reader, si)
        reader.pop()
        return s
      })
    return strings.reduce((pss, ps) => {
      let typeStrings = pss[ps.recType]
      if (!typeStrings) {
        pss[ps.recType] = typeStrings = []
      }

      typeStrings.push(ps)

      return pss
    }, {})
  }
}

},{"./parameter-string":33}],36:[function(require,module,exports){
module.exports = {
  LineElementType: 1,
  AreaElementType: 2,
  CircleElementType: 3,
  DotElementType: 4,
}

},{}],37:[function(require,module,exports){
const TdPoly = require('./td-poly')
const InvalidSymbolElementException = require('./invalid-symbol-element-exception')

/**
 * @class SymbolElement
 * @property {number} type
 * @property {number} flags
 * @property {number} color
 * @property {number} lineWidth
 * @property {number} diameter
 * @property {number} numberCoords
 * @property {TdPoly[]} coords
 */

module.exports = class SymbolElement {
  /**
   * @type {number}
   */
  type
  /**
   * @type {number}
   */
  flags
  /**
   * @type {number}
   */
  color
  /**
   * @type {number}
   */
  lineWidth
  /**
   * @type {number}
   */
  diameter
  /**
   * @type {number}
   */
  numberCoords
  /**
   * @type {TdPoly[]}
   */
  coords

  /**
   * @param {import('./buffer-reader')} reader
   */
  constructor(reader) {
    this.type = reader.readSmallInt()
    this.flags = reader.readWord()
    this.color = reader.readSmallInt()
    this.lineWidth = reader.readSmallInt()
    this.diameter = reader.readSmallInt()
    this.numberCoords = reader.readSmallInt()
    reader.readCardinal() // Reserved

    if (this.type < 1 || this.type > 4) {
      throw new InvalidSymbolElementException(
        `Symbol element with invalid type (${this.type}).`
      )
    }

    if (this.numberCoords >= 0) {
      this.coords = new Array(this.numberCoords)
      for (let j = 0; j < this.numberCoords; j++) {
        this.coords[j] = new TdPoly(reader.readInteger(), reader.readInteger())
      }
    } else {
      // Negative number of coords seems to happen in some files; we ignore it for now.
      throw new InvalidSymbolElementException(
        `Symbol element with invalid (${this.numberCoords}) number of coordinates.`,
        this
      )
    }
  }
}

},{"./invalid-symbol-element-exception":27,"./td-poly":41}],38:[function(require,module,exports){
const PointSymbol = require('./point-symbol')
const LineSymbol = require('./line-symbol')
const AreaSymbol = require('./area-symbol')
const TextSymbol = require('./text-symbol')
const {
  PointSymbolType,
  LineSymbolType,
  AreaSymbolType,
  TextSymbolType,
  RectangleSymbolType,
  LineTextSymbolType,
} = require('./symbol-types')

/** @typedef {import('./buffer-reader')} BufferReader */
/** @typedef {import('./symbol').BaseSymbolDef} Symbol */

module.exports = class SymbolIndexBlock {
  /**
   * @type {number}
   */
  nextSymbolIndexBlock
  /**
   * @type {number[]}
   */
  symbolPosition
  /**
   * @type {string[]}
   */
  warnings

  /**
   * @param {BufferReader} reader
   * @param {number} version
   * @param {import('./').ReadOcadOptions} options
   */
  constructor(reader, version, options = {}) {
    this.version = version
    this.nextSymbolIndexBlock = reader.readInteger()
    this.symbolPosition = new Array(256)
    this.warnings = []
    this.options = options
    for (let i = 0; i < this.symbolPosition.length; i++) {
      this.symbolPosition[i] = reader.readInteger()
    }
  }

  /**
   * @param {BufferReader} reader
   * @returns {Symbol[]}
   */
  parseSymbols(reader) {
    return this.symbolPosition
      .filter(sp => sp > 0)
      .map(sp => this.parseSymbol(reader, sp))
      .filter(s => s)
  }

  /**
   * @param {BufferReader} reader
   * @param {number} offset
   * @returns {Symbol}
   */
  parseSymbol(reader, offset) {
    if (!offset) return

    reader.push(offset)

    const type = reader.buffer.readInt8(offset + 8)
    let symbol
    try {
      let Cls
      switch (type) {
        case PointSymbolType:
          Cls = PointSymbol[this.version]
          break
        case LineSymbolType:
          Cls = LineSymbol[this.version]
          break
        case AreaSymbolType:
          Cls = AreaSymbol[this.version]
          break
        case TextSymbolType:
          Cls = TextSymbol[this.version]
          break
        case LineTextSymbolType:
          this.warnings.push(
            `Ignoring line text symbol ${reader.buffer.readInt32LE(
              offset + 4
            )}.`
          )
          return null
        case RectangleSymbolType:
          this.warnings.push(
            `Ignoring rectangle symbol ${reader.buffer.readInt32LE(
              offset + 4
            )}.`
          )
          return null
        default:
          throw new Error(`Unknown symbol type ${type}`)
      }

      reader.push(offset)
      symbol = new Cls(reader)
      reader.pop()
      this.warnings = this.warnings.concat(symbol.warnings)
    } catch (e) {
      if (!this.options.failOnWarning) {
        this.warnings.push(e)
      } else {
        throw e
      }
    }

    reader.pop()

    return symbol
  }
}

},{"./area-symbol":20,"./line-symbol":28,"./point-symbol":34,"./symbol-types":39,"./text-symbol":42}],39:[function(require,module,exports){
/**
 * @typedef {1} PointSymbolType
 */
/**
 * @typedef {2} LineSymbolType
 */
/**
 * @typedef {3} AreaSymbolType
 */
/**
 * @typedef {4} TextSymbolType
 */
/**
 * @typedef {7} RectangleSymbolType
 */

/**
 * @typedef {PointSymbolType|LineSymbolType|AreaSymbolType|TextSymbolType|RectangleSymbolType} SymbolType
 */

module.exports = {
  PointSymbolType: 1,
  LineSymbolType: 2,
  AreaSymbolType: 3,
  TextSymbolType: 4,
  LineTextSymbolType: 6,
  RectangleSymbolType: 7,
  DblFillColorOn: 1, // Line symbol dblFlag Line color on
}

},{}],40:[function(require,module,exports){
const SymbolElement = require('./symbol-element')
const InvalidSymbolElementException = require('./invalid-symbol-element-exception')

/**
 * @typedef {import('./buffer-reader')} BufferReader
 */

/**
 * @typedef {import('./symbol-types').SymbolType} SymbolType
 */

/**
 * @typedef {Object} BaseSymbolProps
 * @property  {Error[]} warnings
 * @property  {number} size
 * @property  {number} symNum
 * @property  {string} number
 * @property  {number} otp
 * @property  {number} flags
 * @property  {boolean} selected
 * @property  {number} status
 * @property  {number} preferredDrawingTool
 * @property  {number} csMode
 * @property  {number} csObjType
 * @property  {number} csCdFlags
 * @property  {number} extent
 * @property  {number} filePos
 * @property  {number} group
 * @property  {number} nColors
 * @property  {number[]} colors
 * @property  {string} description
 * @property  {number[]} iconBits
 * @property {() => boolean} isHidden
 */

/**
 * @typedef {import('./area-symbol').AreaSymbolDef} AreaSymbol
 */

/**
 * @typedef {import('./line-symbol').LineSymbol} LineSymbol
 */

/**
 * @typedef {import('./point-symbol').PointSymbolDef} PointSymbol
 */

/**
 * @typedef {import('./text-symbol').TextSymbolDef} TextSymbol
 */

/**
 * @typedef {AreaSymbol|LineSymbol|PointSymbol|TextSymbol} BaseSymbolDef
 */

class BaseSymbol {
  /**
   * @type {Error[]}
   */
  warnings
  /**
   * @type {number}
   */
  size
  /**
   * @type {number}
   */
  symNum
  /**
   * @type {string}
   */
  number
  /**
   * @type {number}
   */
  otp
  /**
   * @type {number}
   */
  flags
  /**
   * @type {boolean}
   */
  selected
  /**
   * @type {number}
   */
  status
  /**
   * @type {number}
   */
  preferredDrawingTool
  /**
   * @type {number}
   */
  csMode
  /**
   * @type {number}
   */
  csObjType
  /**
   * @type {number}
   */
  csCdFlags
  /**
   * @type {number}
   */
  extent
  /**
   * @type {number}
   */
  filePos
  /**
   * @type {number}
   */
  group
  /**
   * @type {number}
   */
  nColors
  /**
   * @type {number[]}
   */
  colors
  /**
   * @type {string}
   */
  description
  /**
   * @type {number[]}
   */
  iconBits

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    this.warnings = []
    this.size = reader.readInteger()
    this.symNum = reader.readInteger()
    this.number = `${Math.floor(this.symNum / 1000)}.${this.symNum % 1000}`
    this.otp = reader.readByte()
    this.flags = reader.readByte()
    this.selected = !!reader.readByte()
    this.status = reader.readByte()
    this.preferredDrawingTool = reader.readByte()
    this.csMode = reader.readByte()
    this.csObjType = reader.readByte()
    this.csCdFlags = reader.readByte()
    this.extent = reader.readInteger()
    this.filePos = reader.readCardinal()
  }

  /**
   * @param {BufferReader} reader
   * @param {number} dataSize
   * @returns {SymbolElement[]}
   */
  readElements(reader, dataSize) {
    const elements = []

    for (let i = 0; i < dataSize; i += 2) {
      try {
        reader.push(reader.offset)
        const element = new SymbolElement(reader)
        elements.push(element)

        i += element.numberCoords
      } catch (e) {
        if (e instanceof InvalidSymbolElementException) {
          this.warnings.push(e)
        } else {
          throw e
        }
      } finally {
        const size = reader.getSize()
        reader.pop()
        reader.skip(size)
      }
    }

    return elements
  }

  isHidden() {
    return (this.status & 0x02) === 2
  }
}

class Symbol10 extends BaseSymbol {
  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    this.group = reader.readSmallInt()
    this.nColors = reader.readSmallInt()
    this.colors = new Array(14)
    for (let i = 0; i < this.colors.length; i++) {
      this.colors[i] = reader.readSmallInt()
    }
    this.description = ''
    reader.readByte() // String length
    for (let i = 1; i < 32; i++) {
      const c = reader.readByte()
      if (c) {
        this.description += String.fromCharCode(c)
      }
    }
    this.iconBits = new Array(484)
    for (let i = 0; i < this.iconBits.length; i++) {
      this.iconBits[i] = reader.readByte()
    }
  }
}

class Symbol11 extends BaseSymbol {
  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    reader.readByte() // notUsed1
    reader.readByte() // notUsed2
    this.nColors = reader.readSmallInt()
    this.colors = new Array(14)
    for (let i = 0; i < this.colors.length; i++) {
      this.colors[i] = reader.readSmallInt()
    }
    this.description = ''
    // UTF-16 string, 64 bytes
    // TODO: replace with BufferReader.readWideString()
    for (let i = 0; i < 64 / 2; i++) {
      const c = reader.readWord()
      if (c) {
        this.description += String.fromCharCode(c)
      }
    }

    this.iconBits = new Array(484)
    for (let i = 0; i < this.iconBits.length; i++) {
      this.iconBits[i] = reader.readByte()
    }

    this.symbolTreeGroup = new Array(64)
    for (let i = 0; i < this.symbolTreeGroup.length; i++) {
      this.symbolTreeGroup[i] = reader.readWord()
    }
  }
}

module.exports = {
  Symbol10,
  Symbol11,
}

},{"./invalid-symbol-element-exception":27,"./symbol-element":37}],41:[function(require,module,exports){
/**
 * Represents a TDPoly, which is a coordinate pair with optional flags.
 * The class is an array of X and Y coordinates, with the flags stored in
 * the `xFlags` and `yFlags` properties.
 *
 * OCAD coordinates use 1/100 mm units, unmanipulated coordinates from an OCAD
 * file are 24 bit signed integers.
 *
 * @extends {Array<number>}
 */
class TdPoly extends Array {
  /**
   * @type {number}
   */
  xFlags
  /**
   * @type {number}
   */
  yFlags

  /**
   * @param {number} ocadX
   * @param {number} ocadY
   * @param {number} [xFlags]
   * @param {number} [yFlags]
   */
  constructor(ocadX, ocadY, xFlags, yFlags) {
    super(
      xFlags === undefined ? ocadX >> 8 : ocadX,
      yFlags === undefined ? ocadY >> 8 : ocadY
    )
    this.xFlags = xFlags === undefined ? ocadX & 0xff : xFlags
    this.yFlags = yFlags === undefined ? ocadY & 0xff : yFlags
  }

  isFirstBezier() {
    return !!(this.xFlags & 0x01)
  }

  isSecondBezier() {
    return !!(this.xFlags & 0x02)
  }

  hasNoLeftLine() {
    return this.xFlags & 0x04
  }

  isBorderOrVirtualLine() {
    return !!(this.xFlags & 0x08)
  }

  isCornerPoint() {
    return !!(this.yFlags & 0x01)
  }

  isFirstHolePoint() {
    return !!(this.yFlags & 0x02)
  }

  hasNoRightLine() {
    return this.yFlags & 0x04
  }

  isDashPoint() {
    return !!(this.yFlags & 0x08)
  }

  vLength() {
    return Math.sqrt(this[0] * this[0] + this[1] * this[1])
  }

  add(c1) {
    return new TdPoly(
      this[0] + c1[0],
      this[1] + c1[1],
      this.xFlags,
      this.yFlags
    )
  }

  sub(c1) {
    return new TdPoly(
      this[0] - c1[0],
      this[1] - c1[1],
      this.xFlags,
      this.yFlags
    )
  }

  mul(f) {
    return new TdPoly(this[0] * f, this[1] * f, this.xFlags, this.yFlags)
  }

  unit() {
    const l = this.vLength()
    return this.mul(1 / l)
  }

  rotate(theta) {
    return new TdPoly(
      this[0] * Math.cos(theta) - this[1] * Math.sin(theta),
      this[0] * Math.sin(theta) + this[1] * Math.cos(theta),
      this.xFlags,
      this.yFlags
    )
  }

  /**
   * Compare the coordinates of this `TdPoly` to another `TdPoly`.
   * @param {TdPoly} other
   * @returns `true` if the X and Y of both coordinates are equal
   */
  equalCoords(other) {
    return this[0] === other[0] && this[1] === other[1]
  }
}

/**
 * Instantiate a TdPoly from a pair of coordinates.
 * @param {number} x
 * @param {number} y
 * @returns {TdPoly}
 */
TdPoly.fromCoords = (x, y) => new TdPoly(x << 8, y << 8)

module.exports = TdPoly

},{}],42:[function(require,module,exports){
const { Symbol10, Symbol11 } = require('./symbol')

/** @typedef {import('./buffer-reader')} BufferReader */

/**
 * @typedef {object} TextSymbolProps
 * @property {4} type
 * @property {string} fontName
 * @property {number} fontColor
 * @property {number} fontSize
 * @property {number} weight
 * @property {boolean} italic
 * @property {number} res1
 * @property {number} charSpace
 * @property {number} wordSpace
 * @property {number} alignment
 * @property {number} lineSpace
 * @property {number} paraSpace
 * @property {number} indentFirst
 * @property {number} indentOther
 * @property {number} nTabs
 * @property {number[]} tabs
 * @property {boolean} lbOn
 * @property {number} lbColor
 * @property {number} lbWidth
 * @property {number} lbDist
 * @property {number} res2
 * @property {number} frMode
 * @property {number} frStyle
 * @property {boolean} pointSymOn
 * @property {number} pointSymNumber
 * @property {() => number} getHorizontalAlignment
 * @property {() => number} getVerticalAlignment
 */

/** @typedef {TextSymbolProps & import('./symbol').BaseSymbolProps} TextSymbolDef */

/** @implements {TextSymbolDef} */
class TextSymbol10 extends Symbol10 {
  // Specifying all these in both TextSymbol10 and TextSymbol11 is a bit annoying,
  // but it's the only way I've found to get the TypeScript compiler to understand that
  // TextSymbol10 and TextSymbol11 have the same properties. Maybe there's some JSDoc
  // cleverness that can be used to avoid this duplication.

  /**
   * @type {4}
   */
  type

  /**
   * @type {string}
   */
  fontName
  /**
   * @type {number}
   */
  fontColor
  /**
   * @type {number}
   */
  fontSize
  /**
   * @type {number}
   */
  weight
  /**
   * @type {boolean}
   */
  italic
  /**
   * @type {number}
   */
  res1
  /**
   * @type {number}
   */
  charSpace
  /**
   * @type {number}
   */
  wordSpace
  /**
   * @type {number}
   */
  alignment
  /**
   * @type {number}
   */
  lineSpace
  /**
   * @type {number}
   */
  paraSpace
  /**
   * @type {number}
   */
  indentFirst
  /**
   * @type {number}
   */
  indentOther
  /**
   * @type {number}
   */
  nTabs
  /**
   * @type {number[]}
   */
  tabs
  /**
   * @type {boolean}
   */
  lbOn
  /**
   * @type {number}
   */
  lbColor
  /**
   * @type {number}
   */
  lbWidth
  /**
   * @type {number}
   */
  lbDist
  /**
   * @type {number}
   */
  res2
  /**
   * @type {number}
   */
  frMode
  /**
   * @type {number}
   */
  frStyle
  /**
   * @type {boolean}
   */
  pointSymOn
  /**
   * @type {number}
   */
  pointSymNumber

  /**
   * @param {BufferReader} reader
   */
  constructor(reader) {
    super(reader)

    readTextSymbol(this, reader)
  }

  getVerticalAlignment() {
    return verticalAlignment(this.alignment)
  }

  getHorizontalAlignment() {
    return horizontalAlignment(this.alignment)
  }
}

/** @implements {TextSymbolDef} */
class TextSymbol11 extends Symbol11 {
  /**
   * @type {4}
   */
  type

  /**
   * @type {string}
   */
  fontName
  /**
   * @type {number}
   */
  fontColor
  /**
   * @type {number}
   */
  fontSize
  /**
   * @type {number}
   */
  weight
  /**
   * @type {boolean}
   */
  italic
  /**
   * @type {number}
   */
  res1
  /**
   * @type {number}
   */
  charSpace
  /**
   * @type {number}
   */
  wordSpace
  /**
   * @type {number}
   */
  alignment
  /**
   * @type {number}
   */
  lineSpace
  /**
   * @type {number}
   */
  paraSpace
  /**
   * @type {number}
   */
  indentFirst
  /**
   * @type {number}
   */
  indentOther
  /**
   * @type {number}
   */
  nTabs
  /**
   * @type {number[]}
   */
  tabs
  /**
   * @type {boolean}
   */
  lbOn
  /**
   * @type {number}
   */
  lbColor
  /**
   * @type {number}
   */
  lbWidth
  /**
   * @type {number}
   */
  lbDist
  /**
   * @type {number}
   */
  res2
  /**
   * @type {number}
   */
  frMode
  /**
   * @type {number}
   */
  frStyle
  /**
   * @type {boolean}
   */
  pointSymOn
  /**
   * @type {number}
   */
  pointSymNumber

  constructor(reader) {
    super(reader)

    // TODO: why?
    reader.skip(64)

    readTextSymbol(this, reader)
  }

  getVerticalAlignment() {
    return verticalAlignment(this.alignment)
  }

  getHorizontalAlignment() {
    return horizontalAlignment(this.alignment)
  }
}

/**
 *
 * @param {TextSymbolDef} symbol
 * @param {BufferReader} reader
 */
const readTextSymbol = (symbol, reader) => {
  symbol.type = 4
  // ASCII string, 32 bytes
  symbol.fontName = ''
  const fontLength = reader.readByte() // String length
  for (let i = 0; i < fontLength; i++) {
    const c = reader.readByte()
    if (c) {
      symbol.fontName += String.fromCharCode(c)
    }
  }
  for (let i = 1; i < 32 - fontLength; i++) {
    reader.readByte()
  }

  symbol.fontColor = reader.readSmallInt()
  symbol.fontSize = reader.readSmallInt()
  symbol.weight = reader.readSmallInt()
  symbol.italic = !!reader.readByte()
  symbol.res1 = reader.readByte()
  symbol.charSpace = reader.readSmallInt()
  symbol.wordSpace = reader.readSmallInt()
  symbol.alignment = reader.readSmallInt()
  symbol.lineSpace = reader.readSmallInt()
  symbol.paraSpace = reader.readSmallInt()
  symbol.indentFirst = reader.readSmallInt()
  symbol.indentOther = reader.readSmallInt()
  symbol.nTabs = reader.readSmallInt()
  symbol.tabs = []
  for (let i = 0; i < 32; i++) {
    symbol.tabs.push(reader.readCardinal())
  }
  symbol.lbOn = reader.readWordBool()
  symbol.lbColor = reader.readSmallInt()
  symbol.lbWidth = reader.readSmallInt()
  symbol.lbDist = reader.readSmallInt()
  symbol.res2 = reader.readSmallInt()
  symbol.frMode = reader.readByte()
  symbol.frStyle = reader.readByte()
  symbol.pointSymOn = !!reader.readByte()
  symbol.pointSymNumber = reader.readByte()
  // TODO: Some frame parameters ignored here
}

const verticalAlignment = a => a & 0xfc
const horizontalAlignment = a => a & 0x03

module.exports = {
  10: TextSymbol10,
  11: TextSymbol11,
  12: TextSymbol11,
  2018: TextSymbol11,
  VerticalAlignBottom: 0,
  VerticalAlignMiddle: 4,
  VerticalAlignTop: 8,
  HorizontalAlignLeft: 0,
  HorizontalAlignCenter: 1,
  HorizontalAlignRight: 2,
  HorizontalAlignAllLine: 3,
}

},{"./symbol":40}],43:[function(require,module,exports){
const TdPoly = require('./td-poly')

/** @typedef {import('./buffer-reader')} BufferReader */
/** @typedef {import('./object-index').ObjectIndex} ObjectIndex */

class BaseTObject {
  /** @type {ObjectIndex} */
  objIndex
  /** @type {number} */
  objType
  /** @type {number} */
  sym
  /** @type {number} */
  otp
  /** @type {boolean} */
  unicode
  /** @type {number} */
  ang
  /** @type {number} */
  col
  /** @type {number} */
  lineWidth
  /** @type {number} */
  diamFlags
  /** @type {number} */
  serverObjectId
  /** @type {number} */
  height
  /** @type {number} */
  creationDate
  /** @type {number} */
  multirepresentationId
  /** @type {number} */
  modificationDate
  /** @type {number} */
  nItem
  /** @type {number} */
  nText
  /** @type {number} */
  nObjectString
  /** @type {number} */
  nDatabaseString
  /** @type {number} */
  objectStringType
  /** @type {number} */
  res1
  /** @type {string} */
  text
  /** @type {string|undefined} */
  objectString
  /** @type {string|undefined} */
  databaseString
  /** @type {TdPoly[]} */
  coordinates

  /**
   * @param {BufferReader} reader
   * @param {ObjectIndex} objIndex
   */
  constructor(reader, objIndex) {
    this.objIndex = objIndex
    this.objType = objIndex.objType
  }
}

/**
 * OCAD version 10 TObject structure.
 */
class TObject10 extends BaseTObject {
  /**
   * @param {BufferReader} reader
   * @param {ObjectIndex} objIndex
   */
  constructor(reader, objIndex) {
    super(reader, objIndex)

    this.sym = reader.readInteger()
    this.otp = reader.readByte()
    this.unicode = !!reader.readByte()
    this.ang = reader.readSmallInt()
    this.nItem = reader.readCardinal()
    this.nText = reader.readWord()
    reader.readSmallInt() // Reserved
    this.col = reader.readInteger()
    this.lineWidth = reader.readSmallInt()
    this.diamFlags = reader.readSmallInt()
    reader.readInteger() // Reserved
    reader.readByte() // Reserved
    reader.readByte() // Reserved
    reader.readSmallInt() // Reserved
    this.height = reader.readInteger()
    this.coordinates = new Array(this.nItem)

    reader.skip(4)

    for (let i = 0; i < this.nItem; i++) {
      this.coordinates[i] = new TdPoly(
        reader.readInteger(),
        reader.readInteger()
      )
    }

    this.text = reader.readWideString(this.unicode, this.nText)
  }
}

/**
 * OCAD version 11 TObject structure.
 */
class TObject11 extends BaseTObject {
  /**
   * @param {BufferReader} reader
   * @param {ObjectIndex} objIndex
   */
  constructor(reader, objIndex) {
    super(reader, objIndex)

    this.sym = reader.readInteger()
    this.otp = reader.readByte()
    this.unicode = !!reader.readByte()
    this.ang = reader.readSmallInt()
    this.nItem = reader.readCardinal()
    this.nText = reader.readWord()
    this.mark = reader.readByte()
    this.snappingMark = reader.readByte()
    this.col = reader.readInteger()
    this.lineWidth = reader.readSmallInt()
    this.diamFlags = reader.readSmallInt()
    this.serverObjectId = reader.readInteger()
    this.height = reader.readInteger()
    this._date = reader.readDouble()
    this.coordinates = new Array(this.nItem)

    for (let i = 0; i < this.nItem; i++) {
      this.coordinates[i] = new TdPoly(
        reader.readInteger(),
        reader.readInteger()
      )
    }

    this.text = reader.readWideString(this.unicode, this.nText)
  }
}

/**
 * OCAD version 12 and 2018 TObject structure.
 */
class TObject12 extends BaseTObject {
  /**
   * @param {BufferReader} reader
   * @param {ObjectIndex} objIndex
   */
  constructor(reader, objIndex) {
    super(reader, objIndex)

    this.sym = reader.readInteger()
    this.otp = reader.readByte()
    this.unicode = !!reader.readByte()
    this.ang = reader.readSmallInt()
    this.col = reader.readInteger()
    this.lineWidth = reader.readSmallInt()
    this.diamFlags = reader.readSmallInt()
    this.serverObjectId = reader.readInteger()
    this.height = reader.readInteger()
    this.creationDate = reader.readDouble()
    this.multirepresentationId = reader.readCardinal()
    this.modificationDate = reader.readDouble()
    this.nItem = reader.readCardinal()
    this.nText = reader.readWord()
    this.nObjectString = reader.readWord()
    this.nDatabaseString = reader.readWord()
    this.objectStringType = reader.readByte()
    this.res1 = reader.readByte()
    this.coordinates = new Array(this.nItem)

    for (let i = 0; i < this.nItem; i++) {
      this.coordinates[i] = new TdPoly(
        reader.readInteger(),
        reader.readInteger()
      )
    }

    this.text = reader.readWideString(this.unicode, this.nText)
    this.objectString = reader.readWideString(this.unicode, this.nObjectString)
    this.databaseString = reader.readWideString(
      this.unicode,
      this.nDatabaseString
    )
  }
}

module.exports = {
  TObject: BaseTObject,
  10: TObject10,
  11: TObject11,
  12: TObject12,
  2018: TObject12,
}

},{"./td-poly":41}],44:[function(require,module,exports){
const { coordEach } = require('@turf/meta')
const { featureCollection } = require('@turf/helpers')
const Bezier = require('bezier-js')
const flatten = require('arr-flatten')
const {
  PointObjectType,
  LineObjectType,
  AreaObjectType,
  UnformattedTextObjectType,
  FormattedTextObjectType,
  LineTextObjectType,
} = require('./ocad-reader/object-types')
const {
  LineElementType,
  AreaElementType,
  CircleElementType,
  DotElementType,
} = require('./ocad-reader/symbol-element-types')
const transformFeatures = require('./transform-features')
const TdPoly = require('./ocad-reader/td-poly')

const defaultOptions = {
  applyCrs: true,
  generateSymbolElements: true,
  exportHidden: false,
  coordinatePrecision: 6,
}

module.exports = ocadToGeoJson

/**
 * @typedef {import("./ocad-reader/tobject").TObject} TObject
 */

/** @typedef {import("geojson").Geometry} Geometry */
/**
 * @template {Geometry} TGeometry
 * @template {Object} TProperties
 * @typedef {import("geojson").FeatureCollection<TGeometry, TProperties>} FeatureCollection<TGeometry, TProperties>
 */

/**
 * @template {Geometry} TGeometry
 * @template {Object} TProperties
 * @typedef {import("geojson").Feature<TGeometry, TProperties>} Feature<TGeometry, TProperties>
 */

/**
 * @typedef {import("./transform-features").TransformFeaturesOptions} TransformFeaturesOptions
 *
 * @typedef {object} OcadToGeoJsonOptionsProps
 * @property {boolean=} applyCrs transform coordinates to the file's geographic coordinates (default: `true`)
 * @property {number=} coordinatePrecision number of digits after the decimal point (default: `6`)
 *
 * @typedef {TransformFeaturesOptions & OcadToGeoJsonOptionsProps} OcadToGeoJsonOptions
 */

/**
 * @typedef {Object} OcadObjectProperties
 * @property {number} sym
 * @property {number} otp
 * @property {boolean} unicode
 * @property {number} ang
 * @property {number} col
 * @property {number} lineWidth
 * @property {number} diamFlags
 * @property {number} serverObjectId
 * @property {number} height
 * @property {number} creationDate
 * @property {number} multirepresentationId
 * @property {number} modificationDate
 * @property {number} nItem
 * @property {number} nText
 * @property {number} nObjectString
 * @property {number} nDatabaseString
 * @property {number} objectStringType
 * @property {number} res1
 * @property {string} text
 * @property {string|undefined} objectString
 * @property {string|undefined} databaseString
 * @property {number} objectIndex
 */

/**
 * @typedef {Object} ElementProperties
 * @property {string} element
 * @property {number} parentId
 */

/**
 * Given an `OcadFile` object, returns a GeoJSON `FeatureCollection` of the file's objects.
 * @param {import("./ocad-reader/ocad-file")} ocadFile the OCAD file
 * @param {OcadToGeoJsonOptions=} options options
 * @returns {FeatureCollection<Geometry, OcadObjectProperties>}
 */
function ocadToGeoJson(ocadFile, options) {
  options = { ...defaultOptions, ...options }

  const features = transformFeatures(
    ocadFile,
    tObjectToGeoJson,
    createElement,
    options
  )
  const result = featureCollection(features)

  if (options.applyCrs) {
    applyCrs(result, ocadFile.getCrs())
  }

  coordEach(result, c => {
    c[0] = formatNum(c[0], options.coordinatePrecision)
    c[1] = formatNum(c[1], options.coordinatePrecision)
  })

  return result
}

/**
 *
 * @param {OcadToGeoJsonOptions} options
 * @param {Record<number, import('./ocad-reader/symbol').BaseSymbolDef>} symbols
 * @param {TObject} object
 * @param {number} i
 * @returns {Feature<Geometry, OcadObjectProperties>[]}
 */
const tObjectToGeoJson = (options, symbols, object, i) => {
  const symbol = symbols[object.sym]
  if (!symbol || (!options.exportHidden && symbol.isHidden())) return

  /** @type Geometry */
  let geometry
  switch (object.objType) {
    case PointObjectType:
      geometry = {
        type: 'Point',
        coordinates: object.coordinates[0].slice(),
      }
      break
    case LineObjectType:
      geometry = {
        type: 'LineString',
        coordinates: extractCoords(object.coordinates).map(c => c.slice()),
      }
      break
    case AreaObjectType:
      geometry = {
        type: 'Polygon',
        coordinates: coordinatesToRings(object.coordinates),
      }
      break
    case UnformattedTextObjectType:
    case FormattedTextObjectType:
    case LineTextObjectType: {
      if (!('fontSize' in symbol))
        throw new Error(`Text object's symbol is not a text symbol`)

      const lineHeight = (symbol.fontSize / 10) * 0.352778 * 100
      const anchorCoord = [
        object.coordinates[0][0],
        object.coordinates[0][1] + lineHeight,
      ]

      geometry = {
        type: 'Point',
        coordinates: anchorCoord,
      }
      break
    }
    default:
      return
  }

  return [
    {
      type: 'Feature',
      properties: getProperties(object),
      id: i + 1,
      geometry,
    },
  ]
}

const extractCoords = coords => {
  const cs = []
  let lastC
  let cp1
  let cp2

  for (let i = 0; i < coords.length; i++) {
    const c = coords[i]

    if (c.isFirstBezier()) {
      cp1 = c
    } else if (c.isSecondBezier()) {
      cp2 = c
    } else if (cp1 && cp2) {
      const l = cp2.sub(cp1).vLength()
      const bezier = new Bezier(flatten([lastC, cp1, cp2, c]))
      const bezierCoords = bezier
        .getLUT(Math.round(l / 2))
        .map(bc => TdPoly.fromCoords(bc.x, bc.y))
      cs.push.apply(cs, bezierCoords.slice(1))
      cp1 = cp2 = undefined
      lastC = c
    } else {
      cs.push(c)
      lastC = c
    }
  }

  return cs
}

/**
 * @param {import('./ocad-reader/symbol').BaseSymbolDef} symbol
 * @param {string} name
 * @param {number} index
 * @param {import('./ocad-reader/symbol-element')} element
 * @param {TdPoly} c
 * @param {number} angle
 * @param {TransformFeaturesOptions} options
 * @param {TObject} object
 * @param {number} objectId
 * @returns {Feature<Geometry, ElementProperties>}
 */
const createElement = (
  symbol,
  name,
  index,
  element,
  c,
  angle,
  options,
  object,
  objectId
) => {
  /** @type Geometry */
  let geometry
  const coords = extractCoords(element.coords)
  const rotatedCoords = angle ? coords.map(lc => lc.rotate(angle)) : coords
  const translatedCoords = rotatedCoords.map(lc => lc.add(c))

  switch (element.type) {
    case LineElementType:
      geometry = {
        type: 'LineString',
        coordinates: translatedCoords,
      }
      break
    case AreaElementType:
      geometry = {
        type: 'Polygon',
        coordinates: coordinatesToRings(translatedCoords),
      }
      break
    case CircleElementType:
    case DotElementType:
      geometry = {
        type: 'Point',
        coordinates: translatedCoords[0],
      }
      break
  }

  return {
    type: 'Feature',
    properties: {
      element: `${symbol.symNum}-${name}-${index}`,
      parentId: objectId + 1,
    },
    id: ++options.idCount,
    geometry,
  }
}

const applyCrs = (featureCollection, crs) => {
  coordEach(featureCollection, coord => {
    const crsCoord = crs.toProjectedCoord(coord)

    coord[0] = crsCoord[0]
    coord[1] = crsCoord[1]
  })
}

function formatNum(num, digits) {
  const pow = Math.pow(10, digits === undefined ? 6 : digits)
  return Math.round(num * pow) / pow
}

const coordinatesToRings = coordinates => {
  const rings = []
  let currentRing = []
  rings.push(currentRing)
  for (let i = 0; i < coordinates.length; i++) {
    const c = coordinates[i]
    if (c.isFirstHolePoint()) {
      // Copy first coordinate
      currentRing.push(currentRing[0].slice())
      currentRing = []
      rings.push(currentRing)
    }

    currentRing.push(c.slice())
  }

  // Copy first coordinate
  currentRing.push(currentRing[0].slice())

  return rings
}

/**
 * Returns the GeoJSON properties for this object.
 * @param {TObject} object
 * @returns {OcadObjectProperties}
 */
function getProperties(object) {
  return {
    sym: object.sym,
    otp: object.otp,
    unicode: object.unicode,
    ang: object.ang,
    col: object.col,
    lineWidth: object.lineWidth,
    diamFlags: object.diamFlags,
    serverObjectId: object.serverObjectId,
    height: object.height,
    creationDate: object.creationDate,
    multirepresentationId: object.multirepresentationId,
    modificationDate: object.modificationDate,
    nItem: object.nItem,
    nText: object.nText,
    nObjectString: object.nObjectString,
    nDatabaseString: object.nDatabaseString,
    objectStringType: object.objectStringType,
    res1: object.res1,
    text: object.text,
    objectString: object.objectString,
    databaseString: object.databaseString,
    objectIndex: object.objIndex._index,
  }
}

},{"./ocad-reader/object-types":31,"./ocad-reader/symbol-element-types":36,"./ocad-reader/td-poly":41,"./transform-features":48,"@turf/helpers":1,"@turf/meta":4,"arr-flatten":5,"bezier-js":7}],45:[function(require,module,exports){
const flatten = require('arr-flatten')
const {
  PointSymbolType,
  LineSymbolType,
  AreaSymbolType,
  TextSymbolType,
  DblFillColorOn,
} = require('./ocad-reader/symbol-types')
const {
  LineElementType,
  AreaElementType,
  CircleElementType,
  DotElementType,
} = require('./ocad-reader/symbol-element-types')
const {
  HorizontalAlignCenter,
  HorizontalAlignRight,
  VerticalAlignMiddle,
} = require('./ocad-reader/text-symbol')

module.exports = function ocadToMapboxGlStyle(ocadFile, options) {
  options = { scaleFactor: ocadFile.getCrs().scale / 15000, ...options }
  const usedSymbols = usedSymbolNumbers(ocadFile)
    .map(symNum => ocadFile.symbols.find(s => symNum === s.symNum))
    .filter(s => s)

  const metadata = symbol => {
    const metadata = Object.keys(symbol)
      .filter(k => symbol[k] !== Object(symbol[k]))
      .reduce((a, k) => {
        a[k] = symbol[k]
        return a
      }, {})

    return layer => ({
      ...layer,
      metadata: {
        ...metadata,
        sort: layer.metadata.sort,
      },
    })
  }

  const symbolLayers = flatten(
    usedSymbols.map(symbol =>
      (symbolToMapboxLayer(symbol, ocadFile.colors, options) || []).map(
        metadata(symbol)
      )
    )
  )

  const elementLayers = flatten(
    usedSymbols.map(symbol =>
      (symbolElementsToMapboxLayer(symbol, ocadFile.colors, options) || []).map(
        metadata(symbol)
      )
    )
  )

  return symbolLayers
    .concat(elementLayers)
    .sort((a, b) => b.metadata.sort - a.metadata.sort)
}

const usedSymbolNumbers = ocadFile =>
  ocadFile.objects.reduce(
    (a, f) => {
      const symbolNum = f.sym
      if (!a.idSet.has(symbolNum)) {
        a.symbolNums.push(symbolNum)
        a.idSet.add(symbolNum)
      }

      return a
    },
    { symbolNums: [], idSet: new Set() }
  ).symbolNums

const symbolToMapboxLayer = (symbol, colors, options) => {
  const id = `symbol-${symbol.symNum}`
  const filter = ['==', ['get', 'sym'], symbol.symNum]
  let layerFactory

  switch (symbol.type) {
    case LineSymbolType:
      layerFactory = lineLayer
      break
    case AreaSymbolType:
      layerFactory = areaLayer
      break
    case TextSymbolType:
      layerFactory = textLayer
      break
  }

  return (
    layerFactory &&
    layerFactory(
      id,
      options.source,
      options.sourceLayer,
      options.scaleFactor,
      filter,
      symbol,
      colors
    )
  )
}

const symbolElementsToMapboxLayer = (symbol, colors, options) => {
  var elements = []
  switch (symbol.type) {
    case PointSymbolType:
      elements = symbol.elements.map(e => [e, 'element'])
      break
    case LineSymbolType:
      elements = symbol.primSymElements
        .map(e => [e, 'prim'])
        .concat(symbol.cornerSymElements.map(e => [e, 'corner']))
      break
  }

  return flatten(
    elements
      .map(([e, name], i) =>
        createElementLayer(e, name, i, symbol, colors, options)
      )
      .filter(l => l)
  )
}

const createElementLayer = (element, name, index, symbol, colors, options) => {
  const id = `symbol-${symbol.symNum}-${name}-${index}`
  const filter = ['==', ['get', 'element'], `${symbol.symNum}-${name}-${index}`]

  switch (element.type) {
    case LineElementType:
      return lineLayer(
        id,
        options.source,
        options.sourceLayer,
        options.scaleFactor,
        filter,
        element,
        colors
      )
    case AreaElementType:
      return areaLayer(
        id,
        options.source,
        options.sourceLayer,
        options.scaleFactor,
        filter,
        element,
        colors
      )
    case CircleElementType:
    case DotElementType:
      return circleLayer(
        id,
        options.source,
        options.sourceLayer,
        options.scaleFactor,
        filter,
        element,
        colors
      )
  }
}

const lineLayer = (
  id,
  source,
  sourceLayer,
  scaleFactor,
  filter,
  lineDef,
  colors
) => {
  const createLayer = (id, width, length, gap, color) => {
    if (width <= 0 || color >= colors.length) return

    const baseWidth = (width / 10) * scaleFactor
    const baseMainLength = length / (10 * baseWidth)
    const baseMainGap = gap / (10 * baseWidth)

    const l = {
      id,
      source,
      'source-layer': sourceLayer,
      type: 'line',
      filter,
      paint: {
        'line-color': colors[color].rgb,
        'line-width': expFunc(baseWidth),
      },
      metadata: {
        sort: colors[color].renderOrder,
      },
    }

    if (baseMainLength && baseMainGap) {
      l.paint['line-dasharray'] = [baseMainLength, baseMainGap]
    }

    return l
  }

  const isDoubleLine = lineDef.doubleLine && lineDef.doubleLine.dblMode
  let layers

  if (!isDoubleLine) {
    layers = [
      createLayer(
        id,
        lineDef.lineWidth,
        lineDef.mainLength,
        lineDef.mainGap,
        lineDef.lineColor !== undefined ? lineDef.lineColor : lineDef.color
      ),
    ]
  } else {
    const dbl = lineDef.doubleLine

    // TODO: look into maybe using line-gap-width for some of this
    if (dbl.dblFlags & DblFillColorOn) {
      layers = [
        dbl.dblLeftWidth > 0 &&
          dbl.dblRightWidth > 0 &&
          createLayer(
            id,
            dbl.dblLeftWidth * 1.5 + dbl.dblRightWidth * 1.5 + dbl.dblWidth * 2,
            dbl.dblLength,
            dbl.dblGap,
            dbl.dblLeftColor
          ),
        createLayer(
          id + '_fill',
          dbl.dblWidth * 2,
          dbl.dblLength,
          dbl.dblGap,
          dbl.dblFillColor
        ),
      ]
    } else {
      layers = [
        -dbl.dblWidth - dbl.dblLeftWidth / 2,
        dbl.dblWidth + dbl.dblRightWidth / 2,
      ].map((offset, i) => {
        const l = createLayer(
          id + '_' + i,
          i === 0 ? dbl.dblLeftWidth : dbl.dblRightWidth,
          dbl.dblLength,
          dbl.dblGap,
          i === 0 ? dbl.dblLeftColor : dbl.dblRightColor
        )

        if (l) {
          l.paint['line-offset'] = expFunc((offset / 10) * scaleFactor)
        }

        return l
      })
    }
  }

  return layers.filter(l => l)
}

const areaLayer = (
  id,
  source,
  sourceLayer,
  scaleFactor,
  filter,
  areaDef,
  colors
) => {
  const fillColorIndex =
    areaDef.fillOn !== undefined
      ? areaDef.fillOn
        ? areaDef.fillColor
        : areaDef.colors[0]
      : areaDef.color
  return [
    {
      id,
      source,
      'source-layer': sourceLayer,
      type: 'fill',
      filter,
      paint: {
        'fill-color': colors[fillColorIndex].rgb,
        'fill-opacity':
          areaDef.fillOn === undefined || areaDef.fillOn
            ? 1
            : areaDef.hatchLineWidth / areaDef.hatchDist || 0.5, // TODO: not even close, but emulates hatch/patterns
      },
      metadata: {
        sort: colors[fillColorIndex].renderOrder,
      },
    },
  ]
}

const circleLayer = (
  id,
  source,
  sourceLayer,
  scaleFactor,
  filter,
  element,
  colors
) => {
  const baseRadius = element.diameter / 2 / 10 || 1
  const layer = {
    id,
    source,
    'source-layer': sourceLayer,
    type: 'circle',
    filter,
    paint: {
      'circle-radius': expFunc(baseRadius * scaleFactor),
      'circle-pitch-alignment': 'map',
    },
    metadata: {
      sort: colors[element.color].renderOrder,
    },
  }

  const color = colors[element.color].rgb
  if (element.type === CircleElementType) {
    const baseWidth = element.lineWidth / 10
    layer.paint['circle-opacity'] = 0
    layer.paint['circle-stroke-color'] = color
    layer.paint['circle-stroke-width'] = expFunc(baseWidth)
  } else {
    // DotElementType
    layer.paint['circle-color'] = color
  }

  return [layer]
}

const textLayer = (
  id,
  source,
  sourceLayer,
  scaleFactor,
  filter,
  element,
  colors
) => {
  const horizontalAlign = element.getHorizontalAlignment()
  const verticalAlign = element.getVerticalAlignment()
  const justify =
    horizontalAlign === HorizontalAlignCenter
      ? 'center'
      : horizontalAlign === HorizontalAlignRight
      ? 'right'
      : 'left'
  const anchor = verticalAlign === VerticalAlignMiddle ? 'center' : 'top'

  const weightModifier = element.weight > 400 ? ' Bold' : ''
  const fontVariant = `${weightModifier}${
    element.italic ? ' Italic' : !weightModifier ? ' Regular' : ''
  }`

  const layer = {
    id,
    source,
    'source-layer': sourceLayer,
    type: 'symbol',
    filter,
    layout: {
      'symbol-placement': 'point',
      'text-font': [`Open Sans${fontVariant}`], // , `Arial Unicode MS${fontVariant}`
      'text-field': ['get', 'text'],
      'text-size': expFunc((element.fontSize / 2.3) * scaleFactor),
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-max-width': Infinity,
      'text-justify': justify,
      'text-anchor': `${anchor}${justify !== 'center' ? `-${justify}` : ''}`,
      'text-pitch-alignment': 'map',
      'text-rotation-alignment': 'map',
    },
    paint: {
      'text-color': colors[element.fontColor].rgb,
    },
    metadata: {
      sort: colors[element.fontColor].renderOrder,
    },
  }

  return [layer]
}

const expFunc = base => ({
  type: 'exponential',
  base: 2,
  stops: [
    [0, base * Math.pow(2, 0 - 15)],
    [24, base * Math.pow(2, 24 - 15)],
  ],
})

},{"./ocad-reader/symbol-element-types":36,"./ocad-reader/symbol-types":39,"./ocad-reader/text-symbol":42,"arr-flatten":5}],46:[function(require,module,exports){
(function (global,Buffer){(function (){
const { LineSymbolType, AreaSymbolType } = require('./ocad-reader/symbol-types')
const { patternToSvg, createSvgNode } = require('./ocad-to-svg')
const uuidv4 = require('uuid/v4')
const _global = getGlobal()
const DOMImplementation = _global.DOMImplementation
  ? _global.DOMImplementation
  : new (require('xmldom').DOMImplementation)()
const XMLSerializer = _global.XMLSerializer
  ? _global.XMLSerializer
  : require('xmldom').XMLSerializer

const defaultOptions = {
  generateSymbolElements: true,
  exportHidden: false,
}

/**
 * @typedef {object} NodeDef
//  * @property {string=} id
//  * @property {string} type
//  * @property {Record<string, string|number>=} attrs
//  * @property {NodeDef[]=} children
 */

module.exports = function ocadToQml(ocadFile, options) {
  options = { ...defaultOptions, ...options }

  const usedSymbols = usedSymbolNumbers(ocadFile)
    .map(symNum => ocadFile.symbols.find(s => symNum === s.symNum))
    .filter(s => s)

  const root = {
    type: 'qgis',
    attrs: {
      simplifyMaxScale: 1,
      minScale: 1e8,
      readOnly: 0,
      simplifyDrawingTol: 1,
      hasScaleBasedVisibilityFlag: 0,
      simplifyAlgorithm: 0,
      maxScale: 0,
      labelsEnabled: 0,
      styleCategories: 'AllStyleCategories',
      simplifyDrawingHints: 1,
      simplifyLocal: 1,
    },
    children: [
      {
        type: 'renderer-v2',
        attrs: {
          forceraster: 0,
          symbollevels: 0,
          type: 'RuleRenderer',
          enableorderby: 0,
        },
        children: [
          {
            type: 'rules',
            attrs: {
              key: `{${uuidv4()}}`,
            },
            children: usedSymbols.map((sym, i) => ({
              type: 'rule',
              attrs: {
                key: `{${uuidv4()}}`,
                symbol: i,
                label: `${Math.floor(sym.symNum / 1000)}.${sym.symNum % 1000} ${
                  sym.description
                }`,
                filter: `sym=${sym.symNum}`,
              },
            })),
          },
          {
            type: 'symbols',
            children: usedSymbols
              .map((sym, i) => ({
                ...symbolToQml(ocadFile.getCrs().scale, ocadFile.colors, sym),
                type: 'symbol',
                attrs: {
                  name: i,
                  clip_to_extent: 1,
                  alpha: 1,
                  type:
                    sym.type === LineSymbolType
                      ? 'line'
                      : sym.type === AreaSymbolType
                      ? 'fill'
                      : '',
                  force_rhr: 0,
                },
              }))
              .sort((a, b) => a.order - b.order),
          },
        ],
      },
    ],
  }

  const doc = DOMImplementation.createDocument(null, 'xml', null)
  return createXmlNode(doc, root)
}

/**
 *
 * @param {Document} document
 * @param {NodeDef} n
 * @returns {HTMLElement}
 */
const createXmlNode = (document, n) => {
  const node = document.createElement(n.type)
  if (n.id) {
    node.id = n.id
  }
  if (n.attrs) {
    for (const attrName in n.attrs) {
      node.setAttribute(attrName, n.attrs[attrName].toString())
    }
  }
  if (n.children) {
    for (const child of n.children) {
      node.appendChild(createXmlNode(document, child))
    }
  }

  return node
}

const usedSymbolNumbers = ocadFile =>
  ocadFile.objects.reduce(
    (a, f) => {
      const symbolNum = f.sym
      if (!a.idSet.has(symbolNum)) {
        a.symbolNums.push(symbolNum)
        a.idSet.add(symbolNum)
      }

      return a
    },
    { symbolNums: [], idSet: new Set() }
  ).symbolNums

/**
 * Transform a symbol to QML
 * @param {number} scale
 * @param {*} colors
 * @param {import("./ocad-reader/symbol").BaseSymbolDef} sym
 * @returns {{children: NodeDef[]}}
 */
const symbolToQml = (scale, colors, sym) => {
  /** @type {NodeDef[]} */
  let children

  switch (sym.type) {
    case LineSymbolType: {
      if (sym.type !== 2)
        throw new Error('Symbol mismatch: area object with non-area symbol')
      const lineColor = colors[sym.lineColor]
      if (lineColor) {
        const baseMainGap = sym.mainGap
        const baseMainLength = sym.mainLength
        children = [
          {
            type: 'layer',
            attrs: {
              class: 'SimpleLine',
              pass: 1000 - lineColor.renderOrder,
              enabled: 1,
              locked: 0,
            },
            children: [
              prop(
                'line_color',
                Array.from(lineColor.rgbArray).concat([255]).join(',')
              ),
              prop('line_style', 'solid'),
              prop('line_width', toMapUnit(scale, sym.lineWidth)),
              prop('line_width_unit', 'MapUnit'),
              prop('joinstyle', 'bevel'),
              prop('capstyle', 'flat'),
            ].concat(
              baseMainGap && baseMainLength
                ? [
                    prop(
                      'customdash',
                      [baseMainLength, baseMainGap]
                        .map(x => toMapUnit(scale, x))
                        .join(';')
                    ),
                    prop('customdash_unit', 'MapUnit'),
                    prop('use_custom_dash', 1),
                  ]
                : []
            ),
          },
        ]
      }
      break
    }
    case AreaSymbolType: {
      if (sym.type !== 3)
        throw new Error('Symbol mismatch: area object with non-area symbol')
      const fillColor = colors[sym.fillColor]
      const hasPatternFill = sym.hatchMode || sym.structMode
      children = []
      if (fillColor && (!hasPatternFill || sym.fillOn)) {
        children.push({
          type: 'layer',
          attrs: {
            class: 'SimpleFill',
            pass: 1000 - fillColor.renderOrder,
            enabled: 1,
            locked: 0,
          },
          children: [
            prop(
              'color',
              Array.from(fillColor.rgbArray).concat([255]).join(',')
            ),
            prop('outline_style', 'no'),
            prop('style', 'solid'),
          ],
        })
      }
      if (fillColor && hasPatternFill) {
        const patterns = patternToSvg(colors, sym)
        children = children.concat(
          patterns.map(p => svgPatternToFill(scale, fillColor, p))
        )
      }
      break
    }
  }

  return {
    children,
  }
}

/**
 *
 * @param {number} scale
 * @param {import('./ocad-reader/ocad-file').Color} fillColor
 * @param {NodeDef} pattern
 * @returns {NodeDef}
 */
const svgPatternToFill = (scale, fillColor, pattern) => {
  const { width, height, patternTransform } = pattern.attrs
  const angle = getPatternRotation(patternTransform)
  const svgDoc = DOMImplementation.createDocument(
    'http://www.w3.org/2000/svg',
    'svg',
    null
  )
  svgDoc.firstChild.setAttribute('width', width)
  svgDoc.firstChild.setAttribute('height', height)
  pattern.children.forEach(c =>
    svgDoc.firstChild.appendChild(
      createSvgNode(
        svgDoc,
        /** @type {import('./ocad-to-svg').SvgNodeDef} */ (c)
      )
    )
  )
  const serializedSvg = new XMLSerializer().serializeToString(svgDoc)
  const patternBase64 =
    'base64:' + Buffer.from(serializedSvg).toString('base64')

  return {
    type: 'layer',
    attrs: {
      class: 'SVGFill',
      pass: 1000 - fillColor.renderOrder,
      enabled: 1,
      locked: 0,
    },
    children: [
      prop('pattern_width_unit', 'MapUnit'),
      prop('outline_style', 'no'),
      prop('svgFile', patternBase64),
      prop('width', toMapUnit(scale, width)),
      prop('height', toMapUnit(scale, height)),
      prop('angle', angle),
      {
        type: 'symbol',
        attrs: {
          clip_to_extent: 1,
          alpha: 1,
          type: 'line',
          force_rhr: 0,
        },
        children: [
          {
            type: 'layer',
            attrs: {
              class: 'SimpleLine',
              locked: 0,
              enabled: 1,
              pass: 0,
            },
            children: [
              prop('line_color', '0,0,0,0'),
              prop('line_style', 'solid'),
              prop('line_width', 0),
              prop('line_width_unit', 'MapUnit'),
              prop('joinstyle', 'bevel'),
              prop('capstyle', 'flat'),
            ],
          },
        ],
      },
    ],
  }
}

const prop = (k, v) => ({
  type: 'prop',
  attrs: { k, v },
})

const toMapUnit = (scale, x) => (x / (100 * 1000)) * scale

function getGlobal() {
  if (typeof global !== 'undefined') {
    return global
  } else if (typeof window !== 'undefined') {
    return window
  } else {
    return {}
  }
}

function getPatternRotation(patternTransform) {
  if (patternTransform) {
    const rotationMatch = /rotate\((.*)\)/.exec(patternTransform)
    if (rotationMatch) {
      return Number(rotationMatch[1])
    }
  }
  return 0
}

}).call(this)}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("buffer").Buffer)
},{"./ocad-reader/symbol-types":39,"./ocad-to-svg":47,"buffer":16,"uuid/v4":51,"xmldom":52}],47:[function(require,module,exports){
const { AreaSymbolType, DblFillColorOn } = require('./ocad-reader/symbol-types')
const {
  LineObjectType,
  AreaObjectType,
  LineTextObjectType,
  FormattedTextObjectType,
  UnformattedTextObjectType,
} = require('./ocad-reader/object-types')
const {
  LineElementType,
  AreaElementType,
  CircleElementType,
  DotElementType,
} = require('./ocad-reader/symbol-element-types')
const transformFeatures = require('./transform-features')
const flatten = require('arr-flatten')
// TODO: there must be a better way to make Webpack handle this?
const _lineOffset = require('@turf/line-offset')
const lineOffset =
  _lineOffset.default ||
  /** @type {import('@turf/line-offset').default} */ (
    /** @type {unknown} */ (_lineOffset)
  )
const TdPoly = require('./ocad-reader/td-poly')
const {
  HorizontalAlignCenter,
  HorizontalAlignLeft,
  VerticalAlignTop,
  VerticalAlignBottom,
} = require('./ocad-reader/text-symbol')

const svgNamespace = 'http://www.w3.org/2000/svg'

const defaultOptions = {
  generateSymbolElements: true,
  exportHidden: false,
  fill: 'transparent',
}

const patternToSvg = (colors, s) => {
  const patterns = []

  if (s.hatchMode) {
    const height = s.hatchDist
    const width = 10
    const a1 = s.hatchAngle1
    const a2 = s.hatchAngle2

    patterns.push({
      id: `hatch-fill-${s.symNum}-1`,
      'data-symbol-name': s.name,
      type: 'pattern',
      attrs: {
        patternUnits: 'userSpaceOnUse',
        patternTransform: `rotate(${a1 / 10})`,
        width,
        height,
      },
      children: [
        {
          type: 'rect',
          attrs: {
            x: 0,
            y: 0,
            width,
            height: s.hatchLineWidth,
            fill: colors[s.hatchColor].rgb,
          },
        },
      ],
    })

    if (s.hatchMode === 2) {
      patterns.push({
        id: `hatch-fill-${s.symNum}-2`,
        'data-symbol-name': s.name,
        type: 'pattern',
        attrs: {
          patternUnits: 'userSpaceOnUse',
          patternTransform: `rotate(${a2 / 10})`,
          width,
          height,
        },
        children: [
          {
            type: 'rect',
            attrs: {
              x: 0,
              y: 0,
              width,
              height: s.hatchLineWidth,
              fill: colors[s.hatchColor].rgb,
            },
          },
        ],
      })
    }
  }

  if (s.structMode) {
    const width = s.structWidth
    const height = s.structHeight * (s.structMode === 2 ? 2 : 1)

    patterns.push({
      id: `struct-fill-${s.symNum}`,
      'data-symbol-name': s.name,
      type: 'pattern',
      // , viewbox: `${-width / 2} ${-height / 2} ${width * 1.5} ${height * 1.5}`
      attrs: {
        patternUnits: 'userSpaceOnUse',
        patternTransform: `rotate(${s.structAngle / 10})`,
        width,
        height: height,
      },
      children: s.elements
        .map((e, i) =>
          elementToSvg(
            s,
            '',
            i,
            e,
            [s.structWidth * 0.5, -s.structHeight * 0.5],
            0,
            { colors }
          )
        )
        .concat(
          s.structMode === 2
            ? s.elements
                .map((e, i) =>
                  elementToSvg(
                    s,
                    '',
                    i,
                    e,
                    [s.structWidth, -s.structHeight * 1.5],
                    0,
                    { colors }
                  )
                )
                .concat(
                  s.elements.map((e, i) =>
                    elementToSvg(s, '', i, e, [0, -s.structHeight * 1.5], 0, {
                      colors,
                    })
                  )
                )
            : []
        )
        .filter(Boolean),
    })
  }

  return patterns
}

/**
 * @typedef {object} SvgNodeDef
 * @property {string} type
 * @property {string=} text
 * @property {string=} id
 * @property {number=} order
 * @property {Record<string, string>=} attrs
 * @property {SvgNodeDef[]=} children
 */

/**
 *
 * @param {Document} document
 * @param {SvgNodeDef} n
 * @returns
 */
const createSvgNode = (document, n) => {
  let node
  if (n.text === undefined) {
    node = document.createElementNS(svgNamespace, n.type)
    const xmlnss = Object.entries(n.attrs || []).filter(([key, _]) =>
      key.startsWith('xmlns')
    )
    for (const [ns, uri] of xmlnss) {
      node.setAttributeNS('http://www.w3.org/2000/xmlns/', ns, uri)
    }
    n.id && (node.id = n.id)
    n.attrs &&
      Object.keys(n.attrs).forEach(attrName =>
        node.setAttribute(attrName, n.attrs[attrName])
      )
  } else {
    node = document.createTextNode(n.text)
  }

  n.children &&
    n.children
      .filter(Boolean)
      .forEach(child => node.appendChild(createSvgNode(document, child)))

  return node
}

module.exports = {
  /**
   *
   * @param {import('./ocad-reader/ocad-file')} ocadFile
   * @param {*} options
   * @returns
   */
  ocadToSvg: function (ocadFile, options) {
    options = { ...defaultOptions, ...options }
    const objects = options.objects || ocadFile.objects

    const usedSymbols = usedSymbolNumbers(objects)
      .map(symNum => ocadFile.symbols.find(s => symNum === s.symNum))
      .filter(s => s)

    const patterns = flatten(
      usedSymbols
        .filter(
          s =>
            s.type === AreaSymbolType &&
            'hatchMode' in s &&
            (s.hatchMode || s.structMode)
        )
        .map(patternToSvg.bind(null, ocadFile.colors))
    )

    const bounds = ocadFile.getBounds()
    const childNodes = transformFeatures(
      ocadFile,
      objectToSvg,
      elementToSvg,
      options
    )
    let children
    if (options.fromColor == null && options.toColor == null) {
      children = childNodes
    } else {
      children = childNodes.filter(
        node =>
          (options.fromColor == null || node.order >= options.fromColor) &&
          (options.toColor == null || node.order <= options.toColor)
      )
    }

    children.sort((a, b) => b.order - a.order)
    const root = {
      type: 'svg',
      attrs: {
        xmlns: svgNamespace,
        fill: options.fill,
        viewBox:
          bounds.slice(0, 2) +
          ',' +
          (bounds[2] - bounds[0]) +
          ',' +
          (bounds[3] - bounds[1]),
      },
      children: [
        {
          type: 'defs',
          children: patterns,
        },
      ].concat([
        {
          type: 'g',
          attrs: {
            xmlns: svgNamespace,
            transform: `translate(0, ${bounds[1] + bounds[3]})`,
          },
          children,
        },
      ]),
    }

    return createSvgNode(options.document || window.document, root)
  },
  patternToSvg,
  createSvgNode,
}

const usedSymbolNumbers = objects =>
  Array.from(
    objects.reduce((seen, f) => {
      seen.add(f.sym)
      return seen
    }, new Set())
  )

/**
 *
 * @param {*} options
 * @param {Record<number, import('./ocad-reader/symbol').BaseSymbolDef>} symbols
 * @param {import('./ocad-reader/tobject').TObject} object
 * @returns
 */
const objectToSvg = (options, symbols, object) => {
  const symNum = options.sym || object.sym
  const symbol = symbols[symNum]
  if (!symbol || (!options.exportHidden && symbol.isHidden())) return

  /** @type {SvgNodeDef[]} */
  const nodes = []
  switch (options.objType || object.objType) {
    case LineObjectType: {
      if (symbol.type !== 2) {
        // This somehow seems to happen in some otherwise
        // normal OCAD files; ignore such objects for now.
        // throw new Error(
        //   `Symbol mismatch: line object with non-line symbol (${JSON.stringify(
        //     symbol
        //   )})`
        // )
        return nodes
      }

      const dashPattern = getDashPattern(
        symbol.mainGap,
        symbol.secGap,
        symbol.mainLength,
        symbol.endLength,
        symbol.endGap
      )

      const dbl = symbol.doubleLine
      const dblMode = dbl?.dblMode ?? 0

      const totalFillWidth =
        (dbl?.dblLeftWidth ?? 0) +
        (dbl?.dblWidth ?? 0) +
        (dbl?.dblRightWidth ?? 0)

      // Handle double line rendering based on mode
      // dblMode 0: No double line (handled by regular line rendering below)
      // dblMode 1: True double line (two separate lines with optional fill between)
      // dblMode 2: Full-width filled line (single wide line)

      // dblMode 2: Render as a single wide line with fill color
      if (dblMode === 2 && dbl.dblFillColor != null && totalFillWidth > 0) {
        nodes.push(
          lineToPath(
            object.coordinates,
            totalFillWidth,
            options.colors[dbl.dblFillColor],
            null,
            symbol.lineStyle,
            options.closePath
          )
        )
      }

      if (dblMode === 1) {
        // dblMode 1 without fill color: Render as two separate offset parallel lines
        nodes.push(
          ...[
            [
              -dbl.dblWidth / 2 - dbl.dblLeftWidth / 2,
              dbl.dblLeftWidth,
              dbl.dblLeftColor,
            ],
            [
              dbl.dblWidth / 2 + dbl.dblRightWidth / 2,
              dbl.dblRightWidth,
              dbl.dblRightColor,
            ],
          ]
            .map(([offset, width, color]) => {
              return offsetLineCoordinates(
                object.coordinates,
                offset,
                options.closePath
              ).map(lineCoords => {
                return lineToPath(
                  lineCoords,
                  width,
                  options.colors[color],
                  null,
                  symbol.lineStyle,
                  options.closePath
                )
              })
            })
            .flat()
        )
        if (dbl.dblFlags & DblFillColorOn) {
          nodes.push(
            lineToPath(
              object.coordinates,
              dbl.dblWidth,
              options.colors[dbl.dblFillColor],
              null,
              symbol.lineStyle,
              options.closePath
            )
          )
        }
      }

      if (symbol.frWidth > 0) {
        nodes.push(
          lineToPath(
            object.coordinates,
            symbol.frWidth,
            options.colors[symbol.frColor],
            dashPattern,
            symbol.frStyle,
            options.closePath
          )
        )
      }

      if (symbol.lineWidth > 0) {
        nodes.push(
          lineToPath(
            object.coordinates,
            symbol.lineWidth,
            options.colors[symbol.lineColor],
            dashPattern,
            symbol.lineStyle,
            options.closePath
          )
        )
      }

      break
    }

    case AreaObjectType: {
      if (symbol.type !== 3)
        throw new Error('Symbol mismatch: area object with non-area symbol')
      const fillColorIndex = symbol.fillOn ? symbol.fillColor : symbol.colors[0]
      const fillPattern =
        (symbol.hatchMode && `url(#hatch-fill-${symbol.symNum}-1)`) ||
        (symbol.structMode && `url(#struct-fill-${symbol.symNum})`)

      if (symbol.fillOn) {
        if (fillColorIndex != null) {
          nodes.push(
            areaToPath(object.coordinates, null, options.colors[fillColorIndex])
          )
        }
      }

      if (fillPattern) {
        const patternColor = symbol.hatchMode
          ? symbol.hatchColor
          : symbol.elements.length
            ? Math.min(...symbol.elements.map(e => e.color))
            : // This is a fallback because apparently there are symbols
              // with structMode set but no elements (?!)
              symbol.fillColor
        nodes.push(
          areaToPath(
            object.coordinates,
            fillPattern,
            options.colors[patternColor]
          )
        )

        if (symbol.hatchMode === 2) {
          nodes.push(
            areaToPath(
              object.coordinates,
              `url(#hatch-fill-${symbol.symNum}-2)`,
              options.colors[patternColor]
            )
          )
        }
      }

      if (symbol.borderSym) {
        nodes.push(
          ...objectToSvg(
            {
              ...options,
              sym: symbol.borderSym,
              objType: LineObjectType,
              closePath: true,
            },
            symbols,
            object
          )
        )
      }

      break
    }
    case UnformattedTextObjectType:
    case FormattedTextObjectType:
    case LineTextObjectType: {
      if (symbol.type !== 4)
        throw new Error('Symbol mismatch: text object with non-text symbol')

      const horizontalAlign = symbol.getHorizontalAlignment()
      const verticalAlign = symbol.getVerticalAlignment()
      const [x, y] = object.coordinates[0]
      const fontSize = symbol.fontSize * 3.52778
      const lineHeight = fontSize * 1.2
      const textColor = options.colors[symbol.fontColor]

      const node = {
        type: 'text',
        attrs: {
          x: x.toString(),
          y: (-y).toString(),
          fill: textColor.rgb,
          'font-family': symbol.fontName,
          'font-style': symbol.italic ? 'italic' : '',
          'font-weight': symbol.weight > 400 ? 'bold' : '',
          'font-size': fontSize.toString(), // pt to millimeters * 10
        },
        children: ocadTextToSvg(
          object.coordinates[0],
          object.text,
          horizontalAlign,
          verticalAlign,
          lineHeight
        ),
        order: textColor.renderOrder,
      }
      nodes.push(node)
      break
    }
  }

  return nodes
}

const elementToSvg = (symbol, name, index, element, c, angle, options) => {
  let node
  const rotatedCoords = angle
    ? element.coords.map(lc => lc.rotate(angle))
    : element.coords
  const translatedCoords = rotatedCoords.map(lc => lc.add(c))

  switch (element.type) {
    case LineElementType:
      node = lineToPath(
        translatedCoords,
        element.lineWidth,
        options.colors[element.color],
        getDashPattern(
          element.mainGap,
          element.secGap,
          element.mainLength,
          element.endLength,
          element.endGap
        ),
        element.flags === 1 ? 1 : 0
      )
      break
    case AreaElementType:
      node = areaToPath(translatedCoords, null, options.colors[element.color])
      break
    case CircleElementType:
    case DotElementType:
      node = {
        type: 'circle',
        attrs: {
          cx: c[0],
          cy: -c[1],
          r: element.diameter / 2,
        },
        order: options.colors[element.color].renderOrder,
      }

      node.attrs[element.type === CircleElementType ? 'stroke' : 'fill'] =
        options.colors[element.color].rgb
      if (element.type === CircleElementType) {
        node.attrs['stroke-width'] = element.lineWidth
      }

      break
  }

  return node
}

/**
 * Create a SVG node definition from a set of line coordinates and line styling.
 *
 * @param {TdPoly[]} coordinates
 * @param {number} width
 * @param {import('./ocad-reader/ocad-file').Color} color
 * @param {string|null} dashPattern
 * @param {number=} lineStyle
 * @param {boolean=} closePath
 * @returns {SvgNodeDef}
 */
function lineToPath(
  coordinates,
  width,
  color,
  dashPattern,
  lineStyle,
  closePath
) {
  if (width > 0) {
    return {
      type: 'path',
      attrs: {
        d: coordsToPath(coordinates, closePath),
        style: `stroke: ${color.rgb}; stroke-width: ${width}; ${
          dashPattern ? `stroke-dasharray: ${dashPattern};` : ''
        } stroke-linejoin: ${linejoin(lineStyle)}; stroke-linecap: ${linecap(
          lineStyle
        )};`,
      },
      order: color.renderOrder,
    }
  }
}

// Heavily inspired from
// https://github.com/OpenOrienteering/mapper/blob/69da0d0218e3e46ce8e85976ccd12a3d2b4b8f0c/src/fileformats/ocd_file_import.cpp#L1267
function getDashPattern(mainGap, secGap, mainLength, endLength, endGap) {
  let dashLength
  let breakLength
  // let halfOuterDashes = false
  let dashesInGroup
  let inGroupBreakLength

  if (mainGap || secGap) {
    if (!mainLength) {
      // TODO: warning
    } else if (secGap && !mainGap) {
      dashLength = mainLength - secGap
      breakLength = secGap

      if (endLength) {
        // TODO: warning
      }
    } else {
      dashLength = mainLength
      breakLength = mainGap

      if (endLength && endLength !== mainLength) {
        if (mainLength && endLength / mainLength < 0.75) {
          // halfOuterDashes = true
        }

        if (Math.abs(mainLength - 2 * endLength) > 1) {
          // TODO: warn
        }
      }

      if (secGap) {
        dashesInGroup = 2
        inGroupBreakLength = secGap
        dashLength = (dashLength - inGroupBreakLength) / 2
      }
    }
  }

  if (dashLength) {
    if (dashesInGroup) {
      return `${dashLength} ${inGroupBreakLength} ${dashLength} ${breakLength}`
    } else {
      return `${dashLength} ${breakLength}`
    }
  } else {
    return null
  }
}

function linejoin(lineStyle) {
  // According to docs, line style 2 is used as bitmask for "pointed end", so
  // mask that out first.
  lineStyle = (lineStyle || 0) & (0xff - 2)
  switch (lineStyle) {
    case 0:
      return 'bevel'
    case 1:
      return 'round'
    case 2:
      return 'bevel'
    case 4:
      return 'miter'
    default:
      console.warn(`Unknown line join style ${lineStyle}.`)
      return ''
  }
}

function linecap(lineStyle) {
  // According to docs, line style 2 is used as bitmask for "pointed end", so
  // mask that out first.
  // TODO: support "pointed end" line cap
  lineStyle = (lineStyle || 0) & (0xff - 2)
  switch (lineStyle) {
    case 0:
      return 'butt'
    case 1:
      return 'round'
    case 2:
      return 'butt'
    case 4:
      return 'butt'
    default:
      console.warn(`Unknown line cap style ${lineStyle}.`)
      return ''
  }
}

const areaToPath = (coordinates, fillPattern, color) => ({
  type: 'path',
  attrs: {
    d: coordsToPath(coordinates),
    style: `fill: ${fillPattern || color.rgb};`,
    'fill-rule': 'evenodd',
  },
  order: color.renderOrder,
})

/**
 *
 * @param {import('./ocad-reader/td-poly')[]} coords
 * @param {boolean=} closePath
 * @returns {string}
 */
const coordsToPath = (coords, closePath) => {
  if (coords.length === 0) {
    return ''
  }
  const cs = []
  let cp1
  let cp2
  let ringStart = coords[0]
  // Move to the start of the path
  cs.push(`M ${coords[0][0]} ${-coords[0][1]}`)

  for (let i = 0; i < coords.length; i++) {
    const c = coords[i]

    if (c.isFirstBezier()) {
      cp1 = c
    } else if (c.isSecondBezier()) {
      cp2 = c
    } else if (c.isFirstHolePoint()) {
      if (closePath && !isClosed(c, ringStart)) {
        cs.push(`L ${ringStart[0]} ${-ringStart[1]}`)
      }
      ringStart = c
      cs.push(`M ${c[0]} ${-c[1]}`)
    } else if (cp1 && cp2) {
      const bezier = `C ${cp1[0]} ${-cp1[1]} ${cp2[0]} ${-cp2[1]} ${
        c[0]
      } ${-c[1]}`
      cp1 = cp2 = undefined
      cs.push(bezier)
    } else if (i > 0) {
      cs.push(`L ${c[0]} ${-c[1]}`)
    }
  }

  if (closePath && !isClosed(coords[coords.length - 1], ringStart)) {
    cs.push(`L ${ringStart[0]} ${-ringStart[1]}`)
  }

  return cs.join(' ')

  function isClosed(cFirst, cLast) {
    return cFirst[0] === cLast[0] && cFirst[1] === cLast[1]
  }
}

/**
 * Given an array of `TdPoly`, splits it into LineStrings where there are holes,
 * and offsets each LineString by the specified number of units.
 *
 * @param {TdPoly[]} coordinates
 * @param {number} offset
 * @returns {TdPoly[][]}
 */
const offsetLineCoordinates = (coordinates, offset, isArea) => {
  /** @type {TdPoly[][]} */
  const result = []
  /** @type {TdPoly[]} */
  let current = []

  for (let i = 0; i < coordinates.length; i++) {
    const c = coordinates[i]
    if (!c.isFirstHolePoint()) {
      current.push(c)
    } else {
      result.push(offsetLineString(current))
      current = [c]
    }
  }

  if (current.length > 0) {
    result.push(offsetLineString(current))
  }

  return result

  /**
   *
   * @param {TdPoly[]} coordinates
   * @returns {TdPoly[]}
   */
  function offsetLineString(coordinates) {
    const cs =
      isArea && coordinates[0].equalCoords(coordinates[coordinates.length - 1])
        ? coordinates.slice(0, coordinates.length - 1)
        : coordinates
    return lineOffset(
      {
        type: 'LineString',
        coordinates: cs,
      },
      offset,
      { units: 'degrees' }
    ).geometry.coordinates.map(
      (c, i) =>
        new TdPoly(c[0], c[1], coordinates[i].xFlags, coordinates[i].yFlags)
    )
  }
}

const ocadTextToSvg = (
  coord,
  s,
  horizontalAlign,
  verticalAlign,
  lineHeight
) => {
  const lines = s.split('\n')
  const baseY =
    verticalAlign === VerticalAlignTop
      ? lineHeight
      : verticalAlign === VerticalAlignBottom
        ? 0
        : 0.5 * lineHeight

  return lines.map((l, i) => ({
    type: 'tspan',
    attrs: {
      x: coord[0],
      y: `${-coord[1] + baseY + i * lineHeight}`,
      'text-anchor':
        horizontalAlign === HorizontalAlignCenter
          ? 'middle'
          : horizontalAlign === HorizontalAlignLeft
            ? 'start'
            : 'end',
    },
    children: [{ text: l }],
  }))
}

},{"./ocad-reader/object-types":31,"./ocad-reader/symbol-element-types":36,"./ocad-reader/symbol-types":39,"./ocad-reader/td-poly":41,"./ocad-reader/text-symbol":42,"./transform-features":48,"@turf/line-offset":3,"arr-flatten":5}],48:[function(require,module,exports){
const {
  PointSymbolType,
  LineSymbolType,
} = require('./ocad-reader/symbol-types')

const defaultOptions = {
  generateSymbolElements: true,
  exportHidden: false,
}

module.exports = transformFeatures

/** @typedef {import('./ocad-reader/symbol').BaseSymbolDef} Symbol */
/** @typedef {import('./ocad-reader/symbol-element')} SymbolElement */
/** @typedef {import('./ocad-reader/tobject').TObject} TObject */
/** @typedef {import("./ocad-reader/ocad-file")} OcadFile */

/**
 * @typedef {Object} TransformFeaturesOptions
 * @property {boolean=} generateSymbolElements generate features for symbol elements (default: `true`)
 * @property {boolean=} exportHidden export hidden objects (default: `false`)
 * @property {number[]=} includeSymbols only export features from the given symbols;
 *    symbols are identified by their OCAD internal symbol number (for example `40015`, not `400.15`);
 *    if undefined, all symbols will be exported
 * @property {TObject[]=} objects only export the given objects;
 *    if undefined, all objects, filtered by the `exportHidden` option, will be exported
 * @property {import('./ocad-reader/ocad-file').Color[]=} [colors] the colors of the OCAD file
 * @property {number=} [idCount] the current id count
 */

/**
 * @template {Object} T
 * @typedef {function(TransformFeaturesOptions, Record<number, Symbol>, TObject, number): T[]|null|undefined} CreateObjects
 */

/**
 * @template {Object} U
 * @typedef {(symbol: Symbol, name: string, index: number, element: SymbolElement, c: import('./ocad-reader/td-poly'), angle: number, options: TransformFeaturesOptions, object: TObject, objectId: number) => U|null|undefined} CreateElement
 */

/**
 * @template {Object} T result type
 * @template {Object} U element result type
 * @param {OcadFile} ocadFile
 * @param {CreateObjects<T>} createObjects
 * @param {CreateElement<U>} createElement
 * @param {TransformFeaturesOptions} options
 * @returns {T[]}
 */
function transformFeatures(ocadFile, createObjects, createElement, options) {
  options = {
    ...defaultOptions,
    ...options,
    colors: ocadFile.colors,
    idCount: ocadFile.objects.length,
  }

  const symbols = ocadFile.symbols
    .filter(
      s =>
        !options.includeSymbols ||
        options.includeSymbols.find(symNum => symNum === s.symNum)
    )
    .reduce((ss, s) => {
      ss[s.symNum] = s
      return ss
    }, {})

  const objects = options.objects || ocadFile.objects
  let features = objects
    .map(createObjects.bind(null, options, symbols))
    .flat()
    .filter(Boolean)

  if (options.generateSymbolElements) {
    const elementFeatures = objects
      .map(generateSymbolElements.bind(null, createElement, options, symbols))
      .flat()

    features = features.concat(elementFeatures).filter(Boolean)
  }

  return features
}

const generateSymbolElements = (
  createElement,
  options,
  symbols,
  object,
  objectIndex
) => {
  const symbol = symbols[object.sym]
  /** @type {number[]} */
  let elements = []

  if (!symbol || (!options.exportHidden && symbol.isHidden())) return

  switch (symbol.type) {
    case PointSymbolType: {
      const angle = object.ang ? (object.ang / 10 / 180) * Math.PI : 0
      elements = symbol.elements.map((e, i) =>
        createElement(
          symbol,
          'element',
          i,
          e,
          object.coordinates[0],
          angle,
          options,
          object,
          objectIndex
        )
      )
      break
    }
    case LineSymbolType:
      if (symbol.primSymElements.length > 0 && symbol.mainLength > 0) {
        const coords = object.coordinates
        const endLength = symbol.endLength
        const mainLength = symbol.mainLength
        const spotDist = symbol.primSymDist
        const nPrimSym = symbol.nPrimSym || 1

        // Total length of the polyline.
        let totalLength = 0
        for (let i = 1; i < coords.length; i++) {
          totalLength += coords[i].sub(coords[i - 1]).vLength()
        }

        // Length occupied by the symbols inside a single group.
        const groupLength = (nPrimSym - 1) * spotDist
        // Length available for distributing the symbol groups, i.e. the line
        // minus the empty space at each end.
        const span = totalLength - 2 * endLength

        // OCAD does not place primary symbols at a fixed `mainLength` stride;
        // it distributes the groups evenly so that the line both starts and
        // ends `endLength` away from a symbol, stretching or compressing the
        // main length to fit a whole number of groups. Build the list of
        // distances (measured from the start of the line) at which an
        // individual primary symbol should be placed.
        const distances = []
        if (span <= groupLength) {
          // The line is too short for the configured spacing: draw the minimum
          // number of groups, centered on the line.
          const nGroups = Math.max(1, symbol.minSym + 1)
          const groupSpacing = nGroups > 1 ? totalLength / (nGroups - 1) : 0
          const start = nGroups > 1 ? 0 : (totalLength - groupLength) / 2
          for (let g = 0; g < nGroups; g++) {
            for (let k = 0; k < nPrimSym; k++) {
              distances.push(start + g * groupSpacing + k * spotDist)
            }
          }
        } else {
          const nGaps = Math.max(
            1,
            Math.round((span - groupLength) / mainLength)
          )
          const nGroups = Math.max(symbol.minSym + 1, nGaps + 1)
          const groupSpacing = (span - groupLength) / (nGroups - 1)
          for (let g = 0; g < nGroups; g++) {
            const groupStart = endLength + g * groupSpacing
            for (let k = 0; k < nPrimSym; k++) {
              distances.push(groupStart + k * spotDist)
            }
          }
        }

        // Walk the polyline and place a symbol at each precomputed distance.
        let di = 0
        let segStart = 0
        for (let i = 1; i < coords.length && di < distances.length; i++) {
          const c0 = coords[i - 1]
          const c1 = coords[i]
          const v = c1.sub(c0)
          const angle = Math.atan2(v[1], v[0])
          const u = v.unit()
          const segEnd = segStart + v.vLength()

          while (di < distances.length && distances[di] <= segEnd + 1e-6) {
            const c = c0.add(u.mul(distances[di] - segStart))
            elements = elements.concat(
              symbol.primSymElements.map((e, idx) =>
                createElement(
                  symbol,
                  'prim',
                  idx,
                  e,
                  c,
                  angle,
                  options,
                  object,
                  objectIndex
                )
              )
            )
            di++
          }

          segStart = segEnd
        }
      }

      if (symbol.cornerSymElements.length > 0) {
        const coords = object.coordinates
        for (let i = 1; i < coords.length - 1; i++) {
          const c1 = coords[i]

          if (c1.isCornerPoint()) {
            const c0 = coords[i - 1]
            const v = c1.sub(c0)
            const angle = Math.atan2(v[1], v[0])
            elements = elements.concat(
              symbol.cornerSymElements.map((e, i) =>
                createElement(
                  symbol,
                  'corner',
                  i,
                  e,
                  c1,
                  angle,
                  options,
                  object,
                  objectIndex
                )
              )
            )
          }
        }
      }

      if (symbol.startSymElements.length > 0 && object.coordinates.length > 1) {
        const coords = object.coordinates
        const c0 = coords[0]
        const c1 = coords[1]
        const v = c1.sub(c0)
        const angle = Math.atan2(v[1], v[0])
        elements = elements.concat(
          symbol.startSymElements.map((e, i) =>
            createElement(
              symbol,
              'start',
              i,
              e,
              object.coordinates[0],
              angle,
              options,
              object,
              objectIndex
            )
          )
        )
      }

      if (symbol.endSymElements.length > 0 && object.coordinates.length > 1) {
        const coords = object.coordinates
        const c0 = coords[coords.length - 2]
        const c1 = coords[coords.length - 1]
        const v = c1.sub(c0)
        const angle = Math.atan2(v[1], v[0])
        elements = elements.concat(
          symbol.endSymElements.map((e, i) =>
            createElement(
              symbol,
              'start',
              i,
              e,
              c1,
              angle,
              options,
              object,
              objectIndex
            )
          )
        )
      }
  }

  return elements
}

},{"./ocad-reader/symbol-types":39}],49:[function(require,module,exports){
/**
 * Convert array of 16 byte values to UUID string format of the form:
 * XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
 */
var byteToHex = [];
for (var i = 0; i < 256; ++i) {
  byteToHex[i] = (i + 0x100).toString(16).substr(1);
}

function bytesToUuid(buf, offset) {
  var i = offset || 0;
  var bth = byteToHex;
  // join used to fix memory issue caused by concatenation: https://bugs.chromium.org/p/v8/issues/detail?id=3175#c4
  return ([
    bth[buf[i++]], bth[buf[i++]],
    bth[buf[i++]], bth[buf[i++]], '-',
    bth[buf[i++]], bth[buf[i++]], '-',
    bth[buf[i++]], bth[buf[i++]], '-',
    bth[buf[i++]], bth[buf[i++]], '-',
    bth[buf[i++]], bth[buf[i++]],
    bth[buf[i++]], bth[buf[i++]],
    bth[buf[i++]], bth[buf[i++]]
  ]).join('');
}

module.exports = bytesToUuid;

},{}],50:[function(require,module,exports){
// Unique ID creation requires a high quality random # generator.  In the
// browser this is a little complicated due to unknown quality of Math.random()
// and inconsistent support for the `crypto` API.  We do the best we can via
// feature-detection

// getRandomValues needs to be invoked in a context where "this" is a Crypto
// implementation. Also, find the complete implementation of crypto on IE11.
var getRandomValues = (typeof(crypto) != 'undefined' && crypto.getRandomValues && crypto.getRandomValues.bind(crypto)) ||
                      (typeof(msCrypto) != 'undefined' && typeof window.msCrypto.getRandomValues == 'function' && msCrypto.getRandomValues.bind(msCrypto));

if (getRandomValues) {
  // WHATWG crypto RNG - http://wiki.whatwg.org/wiki/Crypto
  var rnds8 = new Uint8Array(16); // eslint-disable-line no-undef

  module.exports = function whatwgRNG() {
    getRandomValues(rnds8);
    return rnds8;
  };
} else {
  // Math.random()-based (RNG)
  //
  // If all else fails, use Math.random().  It's fast, but is of unspecified
  // quality.
  var rnds = new Array(16);

  module.exports = function mathRNG() {
    for (var i = 0, r; i < 16; i++) {
      if ((i & 0x03) === 0) r = Math.random() * 0x100000000;
      rnds[i] = r >>> ((i & 0x03) << 3) & 0xff;
    }

    return rnds;
  };
}

},{}],51:[function(require,module,exports){
var rng = require('./lib/rng');
var bytesToUuid = require('./lib/bytesToUuid');

function v4(options, buf, offset) {
  var i = buf && offset || 0;

  if (typeof(options) == 'string') {
    buf = options === 'binary' ? new Array(16) : null;
    options = null;
  }
  options = options || {};

  var rnds = options.random || (options.rng || rng)();

  // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`
  rnds[6] = (rnds[6] & 0x0f) | 0x40;
  rnds[8] = (rnds[8] & 0x3f) | 0x80;

  // Copy bytes to buffer, if provided
  if (buf) {
    for (var ii = 0; ii < 16; ++ii) {
      buf[i + ii] = rnds[ii];
    }
  }

  return buf || bytesToUuid(rnds);
}

module.exports = v4;

},{"./lib/bytesToUuid":49,"./lib/rng":50}],52:[function(require,module,exports){
function DOMParser(options){
	this.options = options ||{locator:{}};
}

DOMParser.prototype.parseFromString = function(source,mimeType){
	var options = this.options;
	var sax =  new XMLReader();
	var domBuilder = options.domBuilder || new DOMHandler();//contentHandler and LexicalHandler
	var errorHandler = options.errorHandler;
	var locator = options.locator;
	var defaultNSMap = options.xmlns||{};
	var isHTML = /\/x?html?$/.test(mimeType);//mimeType.toLowerCase().indexOf('html') > -1;
  	var entityMap = isHTML?htmlEntity.entityMap:{'lt':'<','gt':'>','amp':'&','quot':'"','apos':"'"};
	if(locator){
		domBuilder.setDocumentLocator(locator)
	}

	sax.errorHandler = buildErrorHandler(errorHandler,domBuilder,locator);
	sax.domBuilder = options.domBuilder || domBuilder;
	if(isHTML){
		defaultNSMap['']= 'http://www.w3.org/1999/xhtml';
	}
	defaultNSMap.xml = defaultNSMap.xml || 'http://www.w3.org/XML/1998/namespace';
	if(source && typeof source === 'string'){
		sax.parse(source,defaultNSMap,entityMap);
	}else{
		sax.errorHandler.error("invalid doc source");
	}
	return domBuilder.doc;
}
function buildErrorHandler(errorImpl,domBuilder,locator){
	if(!errorImpl){
		if(domBuilder instanceof DOMHandler){
			return domBuilder;
		}
		errorImpl = domBuilder ;
	}
	var errorHandler = {}
	var isCallback = errorImpl instanceof Function;
	locator = locator||{}
	function build(key){
		var fn = errorImpl[key];
		if(!fn && isCallback){
			fn = errorImpl.length == 2?function(msg){errorImpl(key,msg)}:errorImpl;
		}
		errorHandler[key] = fn && function(msg){
			fn('[xmldom '+key+']\t'+msg+_locator(locator));
		}||function(){};
	}
	build('warning');
	build('error');
	build('fatalError');
	return errorHandler;
}

//console.log('#\n\n\n\n\n\n\n####')
/**
 * +ContentHandler+ErrorHandler
 * +LexicalHandler+EntityResolver2
 * -DeclHandler-DTDHandler
 *
 * DefaultHandler:EntityResolver, DTDHandler, ContentHandler, ErrorHandler
 * DefaultHandler2:DefaultHandler,LexicalHandler, DeclHandler, EntityResolver2
 * @link http://www.saxproject.org/apidoc/org/xml/sax/helpers/DefaultHandler.html
 */
function DOMHandler() {
    this.cdata = false;
}
function position(locator,node){
	node.lineNumber = locator.lineNumber;
	node.columnNumber = locator.columnNumber;
}
/**
 * @see org.xml.sax.ContentHandler#startDocument
 * @link http://www.saxproject.org/apidoc/org/xml/sax/ContentHandler.html
 */
DOMHandler.prototype = {
	startDocument : function() {
    	this.doc = new DOMImplementation().createDocument(null, null, null);
    	if (this.locator) {
        	this.doc.documentURI = this.locator.systemId;
    	}
	},
	startElement:function(namespaceURI, localName, qName, attrs) {
		var doc = this.doc;
	    var el = doc.createElementNS(namespaceURI, qName||localName);
	    var len = attrs.length;
	    appendElement(this, el);
	    this.currentElement = el;

		this.locator && position(this.locator,el)
	    for (var i = 0 ; i < len; i++) {
	        var namespaceURI = attrs.getURI(i);
	        var value = attrs.getValue(i);
	        var qName = attrs.getQName(i);
			var attr = doc.createAttributeNS(namespaceURI, qName);
			this.locator &&position(attrs.getLocator(i),attr);
			attr.value = attr.nodeValue = value;
			el.setAttributeNode(attr)
	    }
	},
	endElement:function(namespaceURI, localName, qName) {
		var current = this.currentElement
		var tagName = current.tagName;
		this.currentElement = current.parentNode;
	},
	startPrefixMapping:function(prefix, uri) {
	},
	endPrefixMapping:function(prefix) {
	},
	processingInstruction:function(target, data) {
	    var ins = this.doc.createProcessingInstruction(target, data);
	    this.locator && position(this.locator,ins)
	    appendElement(this, ins);
	},
	ignorableWhitespace:function(ch, start, length) {
	},
	characters:function(chars, start, length) {
		chars = _toString.apply(this,arguments)
		//console.log(chars)
		if(chars){
			if (this.cdata) {
				var charNode = this.doc.createCDATASection(chars);
			} else {
				var charNode = this.doc.createTextNode(chars);
			}
			if(this.currentElement){
				this.currentElement.appendChild(charNode);
			}else if(/^\s*$/.test(chars)){
				this.doc.appendChild(charNode);
				//process xml
			}
			this.locator && position(this.locator,charNode)
		}
	},
	skippedEntity:function(name) {
	},
	endDocument:function() {
		this.doc.normalize();
	},
	setDocumentLocator:function (locator) {
	    if(this.locator = locator){// && !('lineNumber' in locator)){
	    	locator.lineNumber = 0;
	    }
	},
	//LexicalHandler
	comment:function(chars, start, length) {
		chars = _toString.apply(this,arguments)
	    var comm = this.doc.createComment(chars);
	    this.locator && position(this.locator,comm)
	    appendElement(this, comm);
	},

	startCDATA:function() {
	    //used in characters() methods
	    this.cdata = true;
	},
	endCDATA:function() {
	    this.cdata = false;
	},

	startDTD:function(name, publicId, systemId) {
		var impl = this.doc.implementation;
	    if (impl && impl.createDocumentType) {
	        var dt = impl.createDocumentType(name, publicId, systemId);
	        this.locator && position(this.locator,dt)
	        appendElement(this, dt);
	    }
	},
	/**
	 * @see org.xml.sax.ErrorHandler
	 * @link http://www.saxproject.org/apidoc/org/xml/sax/ErrorHandler.html
	 */
	warning:function(error) {
		console.warn('[xmldom warning]\t'+error,_locator(this.locator));
	},
	error:function(error) {
		console.error('[xmldom error]\t'+error,_locator(this.locator));
	},
	fatalError:function(error) {
		throw new ParseError(error, this.locator);
	}
}
function _locator(l){
	if(l){
		return '\n@'+(l.systemId ||'')+'#[line:'+l.lineNumber+',col:'+l.columnNumber+']'
	}
}
function _toString(chars,start,length){
	if(typeof chars == 'string'){
		return chars.substr(start,length)
	}else{//java sax connect width xmldom on rhino(what about: "? && !(chars instanceof String)")
		if(chars.length >= start+length || start){
			return new java.lang.String(chars,start,length)+'';
		}
		return chars;
	}
}

/*
 * @link http://www.saxproject.org/apidoc/org/xml/sax/ext/LexicalHandler.html
 * used method of org.xml.sax.ext.LexicalHandler:
 *  #comment(chars, start, length)
 *  #startCDATA()
 *  #endCDATA()
 *  #startDTD(name, publicId, systemId)
 *
 *
 * IGNORED method of org.xml.sax.ext.LexicalHandler:
 *  #endDTD()
 *  #startEntity(name)
 *  #endEntity(name)
 *
 *
 * @link http://www.saxproject.org/apidoc/org/xml/sax/ext/DeclHandler.html
 * IGNORED method of org.xml.sax.ext.DeclHandler
 * 	#attributeDecl(eName, aName, type, mode, value)
 *  #elementDecl(name, model)
 *  #externalEntityDecl(name, publicId, systemId)
 *  #internalEntityDecl(name, value)
 * @link http://www.saxproject.org/apidoc/org/xml/sax/ext/EntityResolver2.html
 * IGNORED method of org.xml.sax.EntityResolver2
 *  #resolveEntity(String name,String publicId,String baseURI,String systemId)
 *  #resolveEntity(publicId, systemId)
 *  #getExternalSubset(name, baseURI)
 * @link http://www.saxproject.org/apidoc/org/xml/sax/DTDHandler.html
 * IGNORED method of org.xml.sax.DTDHandler
 *  #notationDecl(name, publicId, systemId) {};
 *  #unparsedEntityDecl(name, publicId, systemId, notationName) {};
 */
"endDTD,startEntity,endEntity,attributeDecl,elementDecl,externalEntityDecl,internalEntityDecl,resolveEntity,getExternalSubset,notationDecl,unparsedEntityDecl".replace(/\w+/g,function(key){
	DOMHandler.prototype[key] = function(){return null}
})

/* Private static helpers treated below as private instance methods, so don't need to add these to the public API; we might use a Relator to also get rid of non-standard public properties */
function appendElement (hander,node) {
    if (!hander.currentElement) {
        hander.doc.appendChild(node);
    } else {
        hander.currentElement.appendChild(node);
    }
}//appendChild and setAttributeNS are preformance key

//if(typeof require == 'function'){
var htmlEntity = require('./entities');
var sax = require('./sax');
var XMLReader = sax.XMLReader;
var ParseError = sax.ParseError;
var DOMImplementation = exports.DOMImplementation = require('./dom').DOMImplementation;
exports.XMLSerializer = require('./dom').XMLSerializer ;
exports.DOMParser = DOMParser;
exports.__DOMHandler = DOMHandler;
//}

},{"./dom":53,"./entities":54,"./sax":55}],53:[function(require,module,exports){
function copy(src,dest){
	for(var p in src){
		dest[p] = src[p];
	}
}
/**
^\w+\.prototype\.([_\w]+)\s*=\s*((?:.*\{\s*?[\r\n][\s\S]*?^})|\S.*?(?=[;\r\n]));?
^\w+\.prototype\.([_\w]+)\s*=\s*(\S.*?(?=[;\r\n]));?
 */
function _extends(Class,Super){
	var pt = Class.prototype;
	if(!(pt instanceof Super)){
		function t(){};
		t.prototype = Super.prototype;
		t = new t();
		copy(pt,t);
		Class.prototype = pt = t;
	}
	if(pt.constructor != Class){
		if(typeof Class != 'function'){
			console.error("unknow Class:"+Class)
		}
		pt.constructor = Class
	}
}
var htmlns = 'http://www.w3.org/1999/xhtml' ;
// Node Types
var NodeType = {}
var ELEMENT_NODE                = NodeType.ELEMENT_NODE                = 1;
var ATTRIBUTE_NODE              = NodeType.ATTRIBUTE_NODE              = 2;
var TEXT_NODE                   = NodeType.TEXT_NODE                   = 3;
var CDATA_SECTION_NODE          = NodeType.CDATA_SECTION_NODE          = 4;
var ENTITY_REFERENCE_NODE       = NodeType.ENTITY_REFERENCE_NODE       = 5;
var ENTITY_NODE                 = NodeType.ENTITY_NODE                 = 6;
var PROCESSING_INSTRUCTION_NODE = NodeType.PROCESSING_INSTRUCTION_NODE = 7;
var COMMENT_NODE                = NodeType.COMMENT_NODE                = 8;
var DOCUMENT_NODE               = NodeType.DOCUMENT_NODE               = 9;
var DOCUMENT_TYPE_NODE          = NodeType.DOCUMENT_TYPE_NODE          = 10;
var DOCUMENT_FRAGMENT_NODE      = NodeType.DOCUMENT_FRAGMENT_NODE      = 11;
var NOTATION_NODE               = NodeType.NOTATION_NODE               = 12;

// ExceptionCode
var ExceptionCode = {}
var ExceptionMessage = {};
var INDEX_SIZE_ERR              = ExceptionCode.INDEX_SIZE_ERR              = ((ExceptionMessage[1]="Index size error"),1);
var DOMSTRING_SIZE_ERR          = ExceptionCode.DOMSTRING_SIZE_ERR          = ((ExceptionMessage[2]="DOMString size error"),2);
var HIERARCHY_REQUEST_ERR       = ExceptionCode.HIERARCHY_REQUEST_ERR       = ((ExceptionMessage[3]="Hierarchy request error"),3);
var WRONG_DOCUMENT_ERR          = ExceptionCode.WRONG_DOCUMENT_ERR          = ((ExceptionMessage[4]="Wrong document"),4);
var INVALID_CHARACTER_ERR       = ExceptionCode.INVALID_CHARACTER_ERR       = ((ExceptionMessage[5]="Invalid character"),5);
var NO_DATA_ALLOWED_ERR         = ExceptionCode.NO_DATA_ALLOWED_ERR         = ((ExceptionMessage[6]="No data allowed"),6);
var NO_MODIFICATION_ALLOWED_ERR = ExceptionCode.NO_MODIFICATION_ALLOWED_ERR = ((ExceptionMessage[7]="No modification allowed"),7);
var NOT_FOUND_ERR               = ExceptionCode.NOT_FOUND_ERR               = ((ExceptionMessage[8]="Not found"),8);
var NOT_SUPPORTED_ERR           = ExceptionCode.NOT_SUPPORTED_ERR           = ((ExceptionMessage[9]="Not supported"),9);
var INUSE_ATTRIBUTE_ERR         = ExceptionCode.INUSE_ATTRIBUTE_ERR         = ((ExceptionMessage[10]="Attribute in use"),10);
//level2
var INVALID_STATE_ERR        	= ExceptionCode.INVALID_STATE_ERR        	= ((ExceptionMessage[11]="Invalid state"),11);
var SYNTAX_ERR               	= ExceptionCode.SYNTAX_ERR               	= ((ExceptionMessage[12]="Syntax error"),12);
var INVALID_MODIFICATION_ERR 	= ExceptionCode.INVALID_MODIFICATION_ERR 	= ((ExceptionMessage[13]="Invalid modification"),13);
var NAMESPACE_ERR            	= ExceptionCode.NAMESPACE_ERR           	= ((ExceptionMessage[14]="Invalid namespace"),14);
var INVALID_ACCESS_ERR       	= ExceptionCode.INVALID_ACCESS_ERR      	= ((ExceptionMessage[15]="Invalid access"),15);

/**
 * DOM Level 2
 * Object DOMException
 * @see http://www.w3.org/TR/2000/REC-DOM-Level-2-Core-20001113/ecma-script-binding.html
 * @see http://www.w3.org/TR/REC-DOM-Level-1/ecma-script-language-binding.html
 */
function DOMException(code, message) {
	if(message instanceof Error){
		var error = message;
	}else{
		error = this;
		Error.call(this, ExceptionMessage[code]);
		this.message = ExceptionMessage[code];
		if(Error.captureStackTrace) Error.captureStackTrace(this, DOMException);
	}
	error.code = code;
	if(message) this.message = this.message + ": " + message;
	return error;
};
DOMException.prototype = Error.prototype;
copy(ExceptionCode,DOMException)
/**
 * @see http://www.w3.org/TR/2000/REC-DOM-Level-2-Core-20001113/core.html#ID-536297177
 * The NodeList interface provides the abstraction of an ordered collection of nodes, without defining or constraining how this collection is implemented. NodeList objects in the DOM are live.
 * The items in the NodeList are accessible via an integral index, starting from 0.
 */
function NodeList() {
};
NodeList.prototype = {
	/**
	 * The number of nodes in the list. The range of valid child node indices is 0 to length-1 inclusive.
	 * @standard level1
	 */
	length:0, 
	/**
	 * Returns the indexth item in the collection. If index is greater than or equal to the number of nodes in the list, this returns null.
	 * @standard level1
	 * @param index  unsigned long 
	 *   Index into the collection.
	 * @return Node
	 * 	The node at the indexth position in the NodeList, or null if that is not a valid index. 
	 */
	item: function(index) {
		return this[index] || null;
	},
	toString:function(isHTML,nodeFilter){
		for(var buf = [], i = 0;i<this.length;i++){
			serializeToString(this[i],buf,isHTML,nodeFilter);
		}
		return buf.join('');
	}
};
function LiveNodeList(node,refresh){
	this._node = node;
	this._refresh = refresh
	_updateLiveList(this);
}
function _updateLiveList(list){
	var inc = list._node._inc || list._node.ownerDocument._inc;
	if(list._inc != inc){
		var ls = list._refresh(list._node);
		//console.log(ls.length)
		__set__(list,'length',ls.length);
		copy(ls,list);
		list._inc = inc;
	}
}
LiveNodeList.prototype.item = function(i){
	_updateLiveList(this);
	return this[i];
}

_extends(LiveNodeList,NodeList);
/**
 * 
 * Objects implementing the NamedNodeMap interface are used to represent collections of nodes that can be accessed by name. Note that NamedNodeMap does not inherit from NodeList; NamedNodeMaps are not maintained in any particular order. Objects contained in an object implementing NamedNodeMap may also be accessed by an ordinal index, but this is simply to allow convenient enumeration of the contents of a NamedNodeMap, and does not imply that the DOM specifies an order to these Nodes.
 * NamedNodeMap objects in the DOM are live.
 * used for attributes or DocumentType entities 
 */
function NamedNodeMap() {
};

function _findNodeIndex(list,node){
	var i = list.length;
	while(i--){
		if(list[i] === node){return i}
	}
}

function _addNamedNode(el,list,newAttr,oldAttr){
	if(oldAttr){
		list[_findNodeIndex(list,oldAttr)] = newAttr;
	}else{
		list[list.length++] = newAttr;
	}
	if(el){
		newAttr.ownerElement = el;
		var doc = el.ownerDocument;
		if(doc){
			oldAttr && _onRemoveAttribute(doc,el,oldAttr);
			_onAddAttribute(doc,el,newAttr);
		}
	}
}
function _removeNamedNode(el,list,attr){
	//console.log('remove attr:'+attr)
	var i = _findNodeIndex(list,attr);
	if(i>=0){
		var lastIndex = list.length-1
		while(i<lastIndex){
			list[i] = list[++i]
		}
		list.length = lastIndex;
		if(el){
			var doc = el.ownerDocument;
			if(doc){
				_onRemoveAttribute(doc,el,attr);
				attr.ownerElement = null;
			}
		}
	}else{
		throw DOMException(NOT_FOUND_ERR,new Error(el.tagName+'@'+attr))
	}
}
NamedNodeMap.prototype = {
	length:0,
	item:NodeList.prototype.item,
	getNamedItem: function(key) {
//		if(key.indexOf(':')>0 || key == 'xmlns'){
//			return null;
//		}
		//console.log()
		var i = this.length;
		while(i--){
			var attr = this[i];
			//console.log(attr.nodeName,key)
			if(attr.nodeName == key){
				return attr;
			}
		}
	},
	setNamedItem: function(attr) {
		var el = attr.ownerElement;
		if(el && el!=this._ownerElement){
			throw new DOMException(INUSE_ATTRIBUTE_ERR);
		}
		var oldAttr = this.getNamedItem(attr.nodeName);
		_addNamedNode(this._ownerElement,this,attr,oldAttr);
		return oldAttr;
	},
	/* returns Node */
	setNamedItemNS: function(attr) {// raises: WRONG_DOCUMENT_ERR,NO_MODIFICATION_ALLOWED_ERR,INUSE_ATTRIBUTE_ERR
		var el = attr.ownerElement, oldAttr;
		if(el && el!=this._ownerElement){
			throw new DOMException(INUSE_ATTRIBUTE_ERR);
		}
		oldAttr = this.getNamedItemNS(attr.namespaceURI,attr.localName);
		_addNamedNode(this._ownerElement,this,attr,oldAttr);
		return oldAttr;
	},

	/* returns Node */
	removeNamedItem: function(key) {
		var attr = this.getNamedItem(key);
		_removeNamedNode(this._ownerElement,this,attr);
		return attr;
		
		
	},// raises: NOT_FOUND_ERR,NO_MODIFICATION_ALLOWED_ERR
	
	//for level2
	removeNamedItemNS:function(namespaceURI,localName){
		var attr = this.getNamedItemNS(namespaceURI,localName);
		_removeNamedNode(this._ownerElement,this,attr);
		return attr;
	},
	getNamedItemNS: function(namespaceURI, localName) {
		var i = this.length;
		while(i--){
			var node = this[i];
			if(node.localName == localName && node.namespaceURI == namespaceURI){
				return node;
			}
		}
		return null;
	}
};
/**
 * @see http://www.w3.org/TR/REC-DOM-Level-1/level-one-core.html#ID-102161490
 */
function DOMImplementation(/* Object */ features) {
	this._features = {};
	if (features) {
		for (var feature in features) {
			 this._features = features[feature];
		}
	}
};

DOMImplementation.prototype = {
	hasFeature: function(/* string */ feature, /* string */ version) {
		var versions = this._features[feature.toLowerCase()];
		if (versions && (!version || version in versions)) {
			return true;
		} else {
			return false;
		}
	},
	// Introduced in DOM Level 2:
	createDocument:function(namespaceURI,  qualifiedName, doctype){// raises:INVALID_CHARACTER_ERR,NAMESPACE_ERR,WRONG_DOCUMENT_ERR
		var doc = new Document();
		doc.implementation = this;
		doc.childNodes = new NodeList();
		doc.doctype = doctype;
		if(doctype){
			doc.appendChild(doctype);
		}
		if(qualifiedName){
			var root = doc.createElementNS(namespaceURI,qualifiedName);
			doc.appendChild(root);
		}
		return doc;
	},
	// Introduced in DOM Level 2:
	createDocumentType:function(qualifiedName, publicId, systemId){// raises:INVALID_CHARACTER_ERR,NAMESPACE_ERR
		var node = new DocumentType();
		node.name = qualifiedName;
		node.nodeName = qualifiedName;
		node.publicId = publicId;
		node.systemId = systemId;
		// Introduced in DOM Level 2:
		//readonly attribute DOMString        internalSubset;
		
		//TODO:..
		//  readonly attribute NamedNodeMap     entities;
		//  readonly attribute NamedNodeMap     notations;
		return node;
	}
};


/**
 * @see http://www.w3.org/TR/2000/REC-DOM-Level-2-Core-20001113/core.html#ID-1950641247
 */

function Node() {
};

Node.prototype = {
	firstChild : null,
	lastChild : null,
	previousSibling : null,
	nextSibling : null,
	attributes : null,
	parentNode : null,
	childNodes : null,
	ownerDocument : null,
	nodeValue : null,
	namespaceURI : null,
	prefix : null,
	localName : null,
	// Modified in DOM Level 2:
	insertBefore:function(newChild, refChild){//raises 
		return _insertBefore(this,newChild,refChild);
	},
	replaceChild:function(newChild, oldChild){//raises 
		this.insertBefore(newChild,oldChild);
		if(oldChild){
			this.removeChild(oldChild);
		}
	},
	removeChild:function(oldChild){
		return _removeChild(this,oldChild);
	},
	appendChild:function(newChild){
		return this.insertBefore(newChild,null);
	},
	hasChildNodes:function(){
		return this.firstChild != null;
	},
	cloneNode:function(deep){
		return cloneNode(this.ownerDocument||this,this,deep);
	},
	// Modified in DOM Level 2:
	normalize:function(){
		var child = this.firstChild;
		while(child){
			var next = child.nextSibling;
			if(next && next.nodeType == TEXT_NODE && child.nodeType == TEXT_NODE){
				this.removeChild(next);
				child.appendData(next.data);
			}else{
				child.normalize();
				child = next;
			}
		}
	},
  	// Introduced in DOM Level 2:
	isSupported:function(feature, version){
		return this.ownerDocument.implementation.hasFeature(feature,version);
	},
    // Introduced in DOM Level 2:
    hasAttributes:function(){
    	return this.attributes.length>0;
    },
    lookupPrefix:function(namespaceURI){
    	var el = this;
    	while(el){
    		var map = el._nsMap;
    		//console.dir(map)
    		if(map){
    			for(var n in map){
    				if(map[n] == namespaceURI){
    					return n;
    				}
    			}
    		}
    		el = el.nodeType == ATTRIBUTE_NODE?el.ownerDocument : el.parentNode;
    	}
    	return null;
    },
    // Introduced in DOM Level 3:
    lookupNamespaceURI:function(prefix){
    	var el = this;
    	while(el){
    		var map = el._nsMap;
    		//console.dir(map)
    		if(map){
    			if(prefix in map){
    				return map[prefix] ;
    			}
    		}
    		el = el.nodeType == ATTRIBUTE_NODE?el.ownerDocument : el.parentNode;
    	}
    	return null;
    },
    // Introduced in DOM Level 3:
    isDefaultNamespace:function(namespaceURI){
    	var prefix = this.lookupPrefix(namespaceURI);
    	return prefix == null;
    }
};


function _xmlEncoder(c){
	return c == '<' && '&lt;' ||
         c == '>' && '&gt;' ||
         c == '&' && '&amp;' ||
         c == '"' && '&quot;' ||
         '&#'+c.charCodeAt()+';'
}


copy(NodeType,Node);
copy(NodeType,Node.prototype);

/**
 * @param callback return true for continue,false for break
 * @return boolean true: break visit;
 */
function _visitNode(node,callback){
	if(callback(node)){
		return true;
	}
	if(node = node.firstChild){
		do{
			if(_visitNode(node,callback)){return true}
        }while(node=node.nextSibling)
    }
}



function Document(){
}
function _onAddAttribute(doc,el,newAttr){
	doc && doc._inc++;
	var ns = newAttr.namespaceURI ;
	if(ns == 'http://www.w3.org/2000/xmlns/'){
		//update namespace
		el._nsMap[newAttr.prefix?newAttr.localName:''] = newAttr.value
	}
}
function _onRemoveAttribute(doc,el,newAttr,remove){
	doc && doc._inc++;
	var ns = newAttr.namespaceURI ;
	if(ns == 'http://www.w3.org/2000/xmlns/'){
		//update namespace
		delete el._nsMap[newAttr.prefix?newAttr.localName:'']
	}
}
function _onUpdateChild(doc,el,newChild){
	if(doc && doc._inc){
		doc._inc++;
		//update childNodes
		var cs = el.childNodes;
		if(newChild){
			cs[cs.length++] = newChild;
		}else{
			//console.log(1)
			var child = el.firstChild;
			var i = 0;
			while(child){
				cs[i++] = child;
				child =child.nextSibling;
			}
			cs.length = i;
		}
	}
}

/**
 * attributes;
 * children;
 * 
 * writeable properties:
 * nodeValue,Attr:value,CharacterData:data
 * prefix
 */
function _removeChild(parentNode,child){
	var previous = child.previousSibling;
	var next = child.nextSibling;
	if(previous){
		previous.nextSibling = next;
	}else{
		parentNode.firstChild = next
	}
	if(next){
		next.previousSibling = previous;
	}else{
		parentNode.lastChild = previous;
	}
	_onUpdateChild(parentNode.ownerDocument,parentNode);
	return child;
}
/**
 * preformance key(refChild == null)
 */
function _insertBefore(parentNode,newChild,nextChild){
	var cp = newChild.parentNode;
	if(cp){
		cp.removeChild(newChild);//remove and update
	}
	if(newChild.nodeType === DOCUMENT_FRAGMENT_NODE){
		var newFirst = newChild.firstChild;
		if (newFirst == null) {
			return newChild;
		}
		var newLast = newChild.lastChild;
	}else{
		newFirst = newLast = newChild;
	}
	var pre = nextChild ? nextChild.previousSibling : parentNode.lastChild;

	newFirst.previousSibling = pre;
	newLast.nextSibling = nextChild;
	
	
	if(pre){
		pre.nextSibling = newFirst;
	}else{
		parentNode.firstChild = newFirst;
	}
	if(nextChild == null){
		parentNode.lastChild = newLast;
	}else{
		nextChild.previousSibling = newLast;
	}
	do{
		newFirst.parentNode = parentNode;
	}while(newFirst !== newLast && (newFirst= newFirst.nextSibling))
	_onUpdateChild(parentNode.ownerDocument||parentNode,parentNode);
	//console.log(parentNode.lastChild.nextSibling == null)
	if (newChild.nodeType == DOCUMENT_FRAGMENT_NODE) {
		newChild.firstChild = newChild.lastChild = null;
	}
	return newChild;
}
function _appendSingleChild(parentNode,newChild){
	var cp = newChild.parentNode;
	if(cp){
		var pre = parentNode.lastChild;
		cp.removeChild(newChild);//remove and update
		var pre = parentNode.lastChild;
	}
	var pre = parentNode.lastChild;
	newChild.parentNode = parentNode;
	newChild.previousSibling = pre;
	newChild.nextSibling = null;
	if(pre){
		pre.nextSibling = newChild;
	}else{
		parentNode.firstChild = newChild;
	}
	parentNode.lastChild = newChild;
	_onUpdateChild(parentNode.ownerDocument,parentNode,newChild);
	return newChild;
	//console.log("__aa",parentNode.lastChild.nextSibling == null)
}
Document.prototype = {
	//implementation : null,
	nodeName :  '#document',
	nodeType :  DOCUMENT_NODE,
	doctype :  null,
	documentElement :  null,
	_inc : 1,
	
	insertBefore :  function(newChild, refChild){//raises 
		if(newChild.nodeType == DOCUMENT_FRAGMENT_NODE){
			var child = newChild.firstChild;
			while(child){
				var next = child.nextSibling;
				this.insertBefore(child,refChild);
				child = next;
			}
			return newChild;
		}
		if(this.documentElement == null && newChild.nodeType == ELEMENT_NODE){
			this.documentElement = newChild;
		}
		
		return _insertBefore(this,newChild,refChild),(newChild.ownerDocument = this),newChild;
	},
	removeChild :  function(oldChild){
		if(this.documentElement == oldChild){
			this.documentElement = null;
		}
		return _removeChild(this,oldChild);
	},
	// Introduced in DOM Level 2:
	importNode : function(importedNode,deep){
		return importNode(this,importedNode,deep);
	},
	// Introduced in DOM Level 2:
	getElementById :	function(id){
		var rtv = null;
		_visitNode(this.documentElement,function(node){
			if(node.nodeType == ELEMENT_NODE){
				if(node.getAttribute('id') == id){
					rtv = node;
					return true;
				}
			}
		})
		return rtv;
	},
	
	getElementsByClassName: function(className) {
		var pattern = new RegExp("(^|\\s)" + className + "(\\s|$)");
		return new LiveNodeList(this, function(base) {
			var ls = [];
			_visitNode(base.documentElement, function(node) {
				if(node !== base && node.nodeType == ELEMENT_NODE) {
					if(pattern.test(node.getAttribute('class'))) {
						ls.push(node);
					}
				}
			});
			return ls;
		});
	},
	
	//document factory method:
	createElement :	function(tagName){
		var node = new Element();
		node.ownerDocument = this;
		node.nodeName = tagName;
		node.tagName = tagName;
		node.childNodes = new NodeList();
		var attrs	= node.attributes = new NamedNodeMap();
		attrs._ownerElement = node;
		return node;
	},
	createDocumentFragment :	function(){
		var node = new DocumentFragment();
		node.ownerDocument = this;
		node.childNodes = new NodeList();
		return node;
	},
	createTextNode :	function(data){
		var node = new Text();
		node.ownerDocument = this;
		node.appendData(data)
		return node;
	},
	createComment :	function(data){
		var node = new Comment();
		node.ownerDocument = this;
		node.appendData(data)
		return node;
	},
	createCDATASection :	function(data){
		var node = new CDATASection();
		node.ownerDocument = this;
		node.appendData(data)
		return node;
	},
	createProcessingInstruction :	function(target,data){
		var node = new ProcessingInstruction();
		node.ownerDocument = this;
		node.tagName = node.target = target;
		node.nodeValue= node.data = data;
		return node;
	},
	createAttribute :	function(name){
		var node = new Attr();
		node.ownerDocument	= this;
		node.name = name;
		node.nodeName	= name;
		node.localName = name;
		node.specified = true;
		return node;
	},
	createEntityReference :	function(name){
		var node = new EntityReference();
		node.ownerDocument	= this;
		node.nodeName	= name;
		return node;
	},
	// Introduced in DOM Level 2:
	createElementNS :	function(namespaceURI,qualifiedName){
		var node = new Element();
		var pl = qualifiedName.split(':');
		var attrs	= node.attributes = new NamedNodeMap();
		node.childNodes = new NodeList();
		node.ownerDocument = this;
		node.nodeName = qualifiedName;
		node.tagName = qualifiedName;
		node.namespaceURI = namespaceURI;
		if(pl.length == 2){
			node.prefix = pl[0];
			node.localName = pl[1];
		}else{
			//el.prefix = null;
			node.localName = qualifiedName;
		}
		attrs._ownerElement = node;
		return node;
	},
	// Introduced in DOM Level 2:
	createAttributeNS :	function(namespaceURI,qualifiedName){
		var node = new Attr();
		var pl = qualifiedName.split(':');
		node.ownerDocument = this;
		node.nodeName = qualifiedName;
		node.name = qualifiedName;
		node.namespaceURI = namespaceURI;
		node.specified = true;
		if(pl.length == 2){
			node.prefix = pl[0];
			node.localName = pl[1];
		}else{
			//el.prefix = null;
			node.localName = qualifiedName;
		}
		return node;
	}
};
_extends(Document,Node);


function Element() {
	this._nsMap = {};
};
Element.prototype = {
	nodeType : ELEMENT_NODE,
	hasAttribute : function(name){
		return this.getAttributeNode(name)!=null;
	},
	getAttribute : function(name){
		var attr = this.getAttributeNode(name);
		return attr && attr.value || '';
	},
	getAttributeNode : function(name){
		return this.attributes.getNamedItem(name);
	},
	setAttribute : function(name, value){
		var attr = this.ownerDocument.createAttribute(name);
		attr.value = attr.nodeValue = "" + value;
		this.setAttributeNode(attr)
	},
	removeAttribute : function(name){
		var attr = this.getAttributeNode(name)
		attr && this.removeAttributeNode(attr);
	},
	
	//four real opeartion method
	appendChild:function(newChild){
		if(newChild.nodeType === DOCUMENT_FRAGMENT_NODE){
			return this.insertBefore(newChild,null);
		}else{
			return _appendSingleChild(this,newChild);
		}
	},
	setAttributeNode : function(newAttr){
		return this.attributes.setNamedItem(newAttr);
	},
	setAttributeNodeNS : function(newAttr){
		return this.attributes.setNamedItemNS(newAttr);
	},
	removeAttributeNode : function(oldAttr){
		//console.log(this == oldAttr.ownerElement)
		return this.attributes.removeNamedItem(oldAttr.nodeName);
	},
	//get real attribute name,and remove it by removeAttributeNode
	removeAttributeNS : function(namespaceURI, localName){
		var old = this.getAttributeNodeNS(namespaceURI, localName);
		old && this.removeAttributeNode(old);
	},
	
	hasAttributeNS : function(namespaceURI, localName){
		return this.getAttributeNodeNS(namespaceURI, localName)!=null;
	},
	getAttributeNS : function(namespaceURI, localName){
		var attr = this.getAttributeNodeNS(namespaceURI, localName);
		return attr && attr.value || '';
	},
	setAttributeNS : function(namespaceURI, qualifiedName, value){
		var attr = this.ownerDocument.createAttributeNS(namespaceURI, qualifiedName);
		attr.value = attr.nodeValue = "" + value;
		this.setAttributeNode(attr)
	},
	getAttributeNodeNS : function(namespaceURI, localName){
		return this.attributes.getNamedItemNS(namespaceURI, localName);
	},
	
	getElementsByTagName : function(tagName){
		return new LiveNodeList(this,function(base){
			var ls = [];
			_visitNode(base,function(node){
				if(node !== base && node.nodeType == ELEMENT_NODE && (tagName === '*' || node.tagName == tagName)){
					ls.push(node);
				}
			});
			return ls;
		});
	},
	getElementsByTagNameNS : function(namespaceURI, localName){
		return new LiveNodeList(this,function(base){
			var ls = [];
			_visitNode(base,function(node){
				if(node !== base && node.nodeType === ELEMENT_NODE && (namespaceURI === '*' || node.namespaceURI === namespaceURI) && (localName === '*' || node.localName == localName)){
					ls.push(node);
				}
			});
			return ls;
			
		});
	}
};
Document.prototype.getElementsByTagName = Element.prototype.getElementsByTagName;
Document.prototype.getElementsByTagNameNS = Element.prototype.getElementsByTagNameNS;


_extends(Element,Node);
function Attr() {
};
Attr.prototype.nodeType = ATTRIBUTE_NODE;
_extends(Attr,Node);


function CharacterData() {
};
CharacterData.prototype = {
	data : '',
	substringData : function(offset, count) {
		return this.data.substring(offset, offset+count);
	},
	appendData: function(text) {
		text = this.data+text;
		this.nodeValue = this.data = text;
		this.length = text.length;
	},
	insertData: function(offset,text) {
		this.replaceData(offset,0,text);
	
	},
	appendChild:function(newChild){
		throw new Error(ExceptionMessage[HIERARCHY_REQUEST_ERR])
	},
	deleteData: function(offset, count) {
		this.replaceData(offset,count,"");
	},
	replaceData: function(offset, count, text) {
		var start = this.data.substring(0,offset);
		var end = this.data.substring(offset+count);
		text = start + text + end;
		this.nodeValue = this.data = text;
		this.length = text.length;
	}
}
_extends(CharacterData,Node);
function Text() {
};
Text.prototype = {
	nodeName : "#text",
	nodeType : TEXT_NODE,
	splitText : function(offset) {
		var text = this.data;
		var newText = text.substring(offset);
		text = text.substring(0, offset);
		this.data = this.nodeValue = text;
		this.length = text.length;
		var newNode = this.ownerDocument.createTextNode(newText);
		if(this.parentNode){
			this.parentNode.insertBefore(newNode, this.nextSibling);
		}
		return newNode;
	}
}
_extends(Text,CharacterData);
function Comment() {
};
Comment.prototype = {
	nodeName : "#comment",
	nodeType : COMMENT_NODE
}
_extends(Comment,CharacterData);

function CDATASection() {
};
CDATASection.prototype = {
	nodeName : "#cdata-section",
	nodeType : CDATA_SECTION_NODE
}
_extends(CDATASection,CharacterData);


function DocumentType() {
};
DocumentType.prototype.nodeType = DOCUMENT_TYPE_NODE;
_extends(DocumentType,Node);

function Notation() {
};
Notation.prototype.nodeType = NOTATION_NODE;
_extends(Notation,Node);

function Entity() {
};
Entity.prototype.nodeType = ENTITY_NODE;
_extends(Entity,Node);

function EntityReference() {
};
EntityReference.prototype.nodeType = ENTITY_REFERENCE_NODE;
_extends(EntityReference,Node);

function DocumentFragment() {
};
DocumentFragment.prototype.nodeName =	"#document-fragment";
DocumentFragment.prototype.nodeType =	DOCUMENT_FRAGMENT_NODE;
_extends(DocumentFragment,Node);


function ProcessingInstruction() {
}
ProcessingInstruction.prototype.nodeType = PROCESSING_INSTRUCTION_NODE;
_extends(ProcessingInstruction,Node);
function XMLSerializer(){}
XMLSerializer.prototype.serializeToString = function(node,isHtml,nodeFilter){
	return nodeSerializeToString.call(node,isHtml,nodeFilter);
}
Node.prototype.toString = nodeSerializeToString;
function nodeSerializeToString(isHtml,nodeFilter){
	var buf = [];
	var refNode = this.nodeType == 9 && this.documentElement || this;
	var prefix = refNode.prefix;
	var uri = refNode.namespaceURI;
	
	if(uri && prefix == null){
		//console.log(prefix)
		var prefix = refNode.lookupPrefix(uri);
		if(prefix == null){
			//isHTML = true;
			var visibleNamespaces=[
			{namespace:uri,prefix:null}
			//{namespace:uri,prefix:''}
			]
		}
	}
	serializeToString(this,buf,isHtml,nodeFilter,visibleNamespaces);
	//console.log('###',this.nodeType,uri,prefix,buf.join(''))
	return buf.join('');
}
function needNamespaceDefine(node,isHTML, visibleNamespaces) {
	var prefix = node.prefix||'';
	var uri = node.namespaceURI;
	if (!prefix && !uri){
		return false;
	}
	if (prefix === "xml" && uri === "http://www.w3.org/XML/1998/namespace" 
		|| uri == 'http://www.w3.org/2000/xmlns/'){
		return false;
	}
	
	var i = visibleNamespaces.length 
	//console.log('@@@@',node.tagName,prefix,uri,visibleNamespaces)
	while (i--) {
		var ns = visibleNamespaces[i];
		// get namespace prefix
		//console.log(node.nodeType,node.tagName,ns.prefix,prefix)
		if (ns.prefix == prefix){
			return ns.namespace != uri;
		}
	}
	//console.log(isHTML,uri,prefix=='')
	//if(isHTML && prefix ==null && uri == 'http://www.w3.org/1999/xhtml'){
	//	return false;
	//}
	//node.flag = '11111'
	//console.error(3,true,node.flag,node.prefix,node.namespaceURI)
	return true;
}
function serializeToString(node,buf,isHTML,nodeFilter,visibleNamespaces){
	if(nodeFilter){
		node = nodeFilter(node);
		if(node){
			if(typeof node == 'string'){
				buf.push(node);
				return;
			}
		}else{
			return;
		}
		//buf.sort.apply(attrs, attributeSorter);
	}
	switch(node.nodeType){
	case ELEMENT_NODE:
		if (!visibleNamespaces) visibleNamespaces = [];
		var startVisibleNamespaces = visibleNamespaces.length;
		var attrs = node.attributes;
		var len = attrs.length;
		var child = node.firstChild;
		var nodeName = node.tagName;
		
		isHTML =  (htmlns === node.namespaceURI) ||isHTML 
		buf.push('<',nodeName);
		
		
		
		for(var i=0;i<len;i++){
			// add namespaces for attributes
			var attr = attrs.item(i);
			if (attr.prefix == 'xmlns') {
				visibleNamespaces.push({ prefix: attr.localName, namespace: attr.value });
			}else if(attr.nodeName == 'xmlns'){
				visibleNamespaces.push({ prefix: '', namespace: attr.value });
			}
		}
		for(var i=0;i<len;i++){
			var attr = attrs.item(i);
			if (needNamespaceDefine(attr,isHTML, visibleNamespaces)) {
				var prefix = attr.prefix||'';
				var uri = attr.namespaceURI;
				var ns = prefix ? ' xmlns:' + prefix : " xmlns";
				buf.push(ns, '="' , uri , '"');
				visibleNamespaces.push({ prefix: prefix, namespace:uri });
			}
			serializeToString(attr,buf,isHTML,nodeFilter,visibleNamespaces);
		}
		// add namespace for current node		
		if (needNamespaceDefine(node,isHTML, visibleNamespaces)) {
			var prefix = node.prefix||'';
			var uri = node.namespaceURI;
			if (uri) {
				// Avoid empty namespace value like xmlns:ds=""
				// Empty namespace URL will we produce an invalid XML document
				var ns = prefix ? ' xmlns:' + prefix : " xmlns";
				buf.push(ns, '="' , uri , '"');
				visibleNamespaces.push({ prefix: prefix, namespace:uri });
			}
		}
		
		if(child || isHTML && !/^(?:meta|link|img|br|hr|input)$/i.test(nodeName)){
			buf.push('>');
			//if is cdata child node
			if(isHTML && /^script$/i.test(nodeName)){
				while(child){
					if(child.data){
						buf.push(child.data);
					}else{
						serializeToString(child,buf,isHTML,nodeFilter,visibleNamespaces);
					}
					child = child.nextSibling;
				}
			}else
			{
				while(child){
					serializeToString(child,buf,isHTML,nodeFilter,visibleNamespaces);
					child = child.nextSibling;
				}
			}
			buf.push('</',nodeName,'>');
		}else{
			buf.push('/>');
		}
		// remove added visible namespaces
		//visibleNamespaces.length = startVisibleNamespaces;
		return;
	case DOCUMENT_NODE:
	case DOCUMENT_FRAGMENT_NODE:
		var child = node.firstChild;
		while(child){
			serializeToString(child,buf,isHTML,nodeFilter,visibleNamespaces);
			child = child.nextSibling;
		}
		return;
	case ATTRIBUTE_NODE:
		/**
		 * Well-formedness constraint: No < in Attribute Values
		 * The replacement text of any entity referred to directly or indirectly in an attribute value must not contain a <.
		 * @see https://www.w3.org/TR/xml/#CleanAttrVals
		 * @see https://www.w3.org/TR/xml/#NT-AttValue
		 */
		return buf.push(' ', node.name, '="', node.value.replace(/[<&"]/g,_xmlEncoder), '"');
	case TEXT_NODE:
		/**
		 * The ampersand character (&) and the left angle bracket (<) must not appear in their literal form,
		 * except when used as markup delimiters, or within a comment, a processing instruction, or a CDATA section.
		 * If they are needed elsewhere, they must be escaped using either numeric character references or the strings
		 * `&amp;` and `&lt;` respectively.
		 * The right angle bracket (>) may be represented using the string " &gt; ", and must, for compatibility,
		 * be escaped using either `&gt;` or a character reference when it appears in the string `]]>` in content,
		 * when that string is not marking the end of a CDATA section.
		 *
		 * In the content of elements, character data is any string of characters
		 * which does not contain the start-delimiter of any markup
		 * and does not include the CDATA-section-close delimiter, `]]>`.
		 *
		 * @see https://www.w3.org/TR/xml/#NT-CharData
		 */
		return buf.push(node.data
			.replace(/[<&]/g,_xmlEncoder)
			.replace(/]]>/g, ']]&gt;')
		);
	case CDATA_SECTION_NODE:
		return buf.push( '<![CDATA[',node.data,']]>');
	case COMMENT_NODE:
		return buf.push( "<!--",node.data,"-->");
	case DOCUMENT_TYPE_NODE:
		var pubid = node.publicId;
		var sysid = node.systemId;
		buf.push('<!DOCTYPE ',node.name);
		if(pubid){
			buf.push(' PUBLIC ', pubid);
			if (sysid && sysid!='.') {
				buf.push(' ', sysid);
			}
			buf.push('>');
		}else if(sysid && sysid!='.'){
			buf.push(' SYSTEM ', sysid, '>');
		}else{
			var sub = node.internalSubset;
			if(sub){
				buf.push(" [",sub,"]");
			}
			buf.push(">");
		}
		return;
	case PROCESSING_INSTRUCTION_NODE:
		return buf.push( "<?",node.target," ",node.data,"?>");
	case ENTITY_REFERENCE_NODE:
		return buf.push( '&',node.nodeName,';');
	//case ENTITY_NODE:
	//case NOTATION_NODE:
	default:
		buf.push('??',node.nodeName);
	}
}
function importNode(doc,node,deep){
	var node2;
	switch (node.nodeType) {
	case ELEMENT_NODE:
		node2 = node.cloneNode(false);
		node2.ownerDocument = doc;
		//var attrs = node2.attributes;
		//var len = attrs.length;
		//for(var i=0;i<len;i++){
			//node2.setAttributeNodeNS(importNode(doc,attrs.item(i),deep));
		//}
	case DOCUMENT_FRAGMENT_NODE:
		break;
	case ATTRIBUTE_NODE:
		deep = true;
		break;
	//case ENTITY_REFERENCE_NODE:
	//case PROCESSING_INSTRUCTION_NODE:
	////case TEXT_NODE:
	//case CDATA_SECTION_NODE:
	//case COMMENT_NODE:
	//	deep = false;
	//	break;
	//case DOCUMENT_NODE:
	//case DOCUMENT_TYPE_NODE:
	//cannot be imported.
	//case ENTITY_NODE:
	//case NOTATION_NODE：
	//can not hit in level3
	//default:throw e;
	}
	if(!node2){
		node2 = node.cloneNode(false);//false
	}
	node2.ownerDocument = doc;
	node2.parentNode = null;
	if(deep){
		var child = node.firstChild;
		while(child){
			node2.appendChild(importNode(doc,child,deep));
			child = child.nextSibling;
		}
	}
	return node2;
}
//
//var _relationMap = {firstChild:1,lastChild:1,previousSibling:1,nextSibling:1,
//					attributes:1,childNodes:1,parentNode:1,documentElement:1,doctype,};
function cloneNode(doc,node,deep){
	var node2 = new node.constructor();
	for(var n in node){
		var v = node[n];
		if(typeof v != 'object' ){
			if(v != node2[n]){
				node2[n] = v;
			}
		}
	}
	if(node.childNodes){
		node2.childNodes = new NodeList();
	}
	node2.ownerDocument = doc;
	switch (node2.nodeType) {
	case ELEMENT_NODE:
		var attrs	= node.attributes;
		var attrs2	= node2.attributes = new NamedNodeMap();
		var len = attrs.length
		attrs2._ownerElement = node2;
		for(var i=0;i<len;i++){
			node2.setAttributeNode(cloneNode(doc,attrs.item(i),true));
		}
		break;;
	case ATTRIBUTE_NODE:
		deep = true;
	}
	if(deep){
		var child = node.firstChild;
		while(child){
			node2.appendChild(cloneNode(doc,child,deep));
			child = child.nextSibling;
		}
	}
	return node2;
}

function __set__(object,key,value){
	object[key] = value
}
//do dynamic
try{
	if(Object.defineProperty){
		Object.defineProperty(LiveNodeList.prototype,'length',{
			get:function(){
				_updateLiveList(this);
				return this.$$length;
			}
		});
		Object.defineProperty(Node.prototype,'textContent',{
			get:function(){
				return getTextContent(this);
			},
			set:function(data){
				switch(this.nodeType){
				case ELEMENT_NODE:
				case DOCUMENT_FRAGMENT_NODE:
					while(this.firstChild){
						this.removeChild(this.firstChild);
					}
					if(data || String(data)){
						this.appendChild(this.ownerDocument.createTextNode(data));
					}
					break;
				default:
					//TODO:
					this.data = data;
					this.value = data;
					this.nodeValue = data;
				}
			}
		})
		
		function getTextContent(node){
			switch(node.nodeType){
			case ELEMENT_NODE:
			case DOCUMENT_FRAGMENT_NODE:
				var buf = [];
				node = node.firstChild;
				while(node){
					if(node.nodeType!==7 && node.nodeType !==8){
						buf.push(getTextContent(node));
					}
					node = node.nextSibling;
				}
				return buf.join('');
			default:
				return node.nodeValue;
			}
		}
		__set__ = function(object,key,value){
			//console.log(value)
			object['$$'+key] = value
		}
	}
}catch(e){//ie8
}

//if(typeof require == 'function'){
	exports.Node = Node;
	exports.DOMException = DOMException;
	exports.DOMImplementation = DOMImplementation;
	exports.XMLSerializer = XMLSerializer;
//}

},{}],54:[function(require,module,exports){
exports.entityMap = {
       lt: '<',
       gt: '>',
       amp: '&',
       quot: '"',
       apos: "'",
       Agrave: "À",
       Aacute: "Á",
       Acirc: "Â",
       Atilde: "Ã",
       Auml: "Ä",
       Aring: "Å",
       AElig: "Æ",
       Ccedil: "Ç",
       Egrave: "È",
       Eacute: "É",
       Ecirc: "Ê",
       Euml: "Ë",
       Igrave: "Ì",
       Iacute: "Í",
       Icirc: "Î",
       Iuml: "Ï",
       ETH: "Ð",
       Ntilde: "Ñ",
       Ograve: "Ò",
       Oacute: "Ó",
       Ocirc: "Ô",
       Otilde: "Õ",
       Ouml: "Ö",
       Oslash: "Ø",
       Ugrave: "Ù",
       Uacute: "Ú",
       Ucirc: "Û",
       Uuml: "Ü",
       Yacute: "Ý",
       THORN: "Þ",
       szlig: "ß",
       agrave: "à",
       aacute: "á",
       acirc: "â",
       atilde: "ã",
       auml: "ä",
       aring: "å",
       aelig: "æ",
       ccedil: "ç",
       egrave: "è",
       eacute: "é",
       ecirc: "ê",
       euml: "ë",
       igrave: "ì",
       iacute: "í",
       icirc: "î",
       iuml: "ï",
       eth: "ð",
       ntilde: "ñ",
       ograve: "ò",
       oacute: "ó",
       ocirc: "ô",
       otilde: "õ",
       ouml: "ö",
       oslash: "ø",
       ugrave: "ù",
       uacute: "ú",
       ucirc: "û",
       uuml: "ü",
       yacute: "ý",
       thorn: "þ",
       yuml: "ÿ",
       nbsp: "\u00a0",
       iexcl: "¡",
       cent: "¢",
       pound: "£",
       curren: "¤",
       yen: "¥",
       brvbar: "¦",
       sect: "§",
       uml: "¨",
       copy: "©",
       ordf: "ª",
       laquo: "«",
       not: "¬",
       shy: "­­",
       reg: "®",
       macr: "¯",
       deg: "°",
       plusmn: "±",
       sup2: "²",
       sup3: "³",
       acute: "´",
       micro: "µ",
       para: "¶",
       middot: "·",
       cedil: "¸",
       sup1: "¹",
       ordm: "º",
       raquo: "»",
       frac14: "¼",
       frac12: "½",
       frac34: "¾",
       iquest: "¿",
       times: "×",
       divide: "÷",
       forall: "∀",
       part: "∂",
       exist: "∃",
       empty: "∅",
       nabla: "∇",
       isin: "∈",
       notin: "∉",
       ni: "∋",
       prod: "∏",
       sum: "∑",
       minus: "−",
       lowast: "∗",
       radic: "√",
       prop: "∝",
       infin: "∞",
       ang: "∠",
       and: "∧",
       or: "∨",
       cap: "∩",
       cup: "∪",
       'int': "∫",
       there4: "∴",
       sim: "∼",
       cong: "≅",
       asymp: "≈",
       ne: "≠",
       equiv: "≡",
       le: "≤",
       ge: "≥",
       sub: "⊂",
       sup: "⊃",
       nsub: "⊄",
       sube: "⊆",
       supe: "⊇",
       oplus: "⊕",
       otimes: "⊗",
       perp: "⊥",
       sdot: "⋅",
       Alpha: "Α",
       Beta: "Β",
       Gamma: "Γ",
       Delta: "Δ",
       Epsilon: "Ε",
       Zeta: "Ζ",
       Eta: "Η",
       Theta: "Θ",
       Iota: "Ι",
       Kappa: "Κ",
       Lambda: "Λ",
       Mu: "Μ",
       Nu: "Ν",
       Xi: "Ξ",
       Omicron: "Ο",
       Pi: "Π",
       Rho: "Ρ",
       Sigma: "Σ",
       Tau: "Τ",
       Upsilon: "Υ",
       Phi: "Φ",
       Chi: "Χ",
       Psi: "Ψ",
       Omega: "Ω",
       alpha: "α",
       beta: "β",
       gamma: "γ",
       delta: "δ",
       epsilon: "ε",
       zeta: "ζ",
       eta: "η",
       theta: "θ",
       iota: "ι",
       kappa: "κ",
       lambda: "λ",
       mu: "μ",
       nu: "ν",
       xi: "ξ",
       omicron: "ο",
       pi: "π",
       rho: "ρ",
       sigmaf: "ς",
       sigma: "σ",
       tau: "τ",
       upsilon: "υ",
       phi: "φ",
       chi: "χ",
       psi: "ψ",
       omega: "ω",
       thetasym: "ϑ",
       upsih: "ϒ",
       piv: "ϖ",
       OElig: "Œ",
       oelig: "œ",
       Scaron: "Š",
       scaron: "š",
       Yuml: "Ÿ",
       fnof: "ƒ",
       circ: "ˆ",
       tilde: "˜",
       ensp: " ",
       emsp: " ",
       thinsp: " ",
       zwnj: "‌",
       zwj: "‍",
       lrm: "‎",
       rlm: "‏",
       ndash: "–",
       mdash: "—",
       lsquo: "‘",
       rsquo: "’",
       sbquo: "‚",
       ldquo: "“",
       rdquo: "”",
       bdquo: "„",
       dagger: "†",
       Dagger: "‡",
       bull: "•",
       hellip: "…",
       permil: "‰",
       prime: "′",
       Prime: "″",
       lsaquo: "‹",
       rsaquo: "›",
       oline: "‾",
       euro: "€",
       trade: "™",
       larr: "←",
       uarr: "↑",
       rarr: "→",
       darr: "↓",
       harr: "↔",
       crarr: "↵",
       lceil: "⌈",
       rceil: "⌉",
       lfloor: "⌊",
       rfloor: "⌋",
       loz: "◊",
       spades: "♠",
       clubs: "♣",
       hearts: "♥",
       diams: "♦"
};

},{}],55:[function(require,module,exports){
//[4]   	NameStartChar	   ::=   	":" | [A-Z] | "_" | [a-z] | [#xC0-#xD6] | [#xD8-#xF6] | [#xF8-#x2FF] | [#x370-#x37D] | [#x37F-#x1FFF] | [#x200C-#x200D] | [#x2070-#x218F] | [#x2C00-#x2FEF] | [#x3001-#xD7FF] | [#xF900-#xFDCF] | [#xFDF0-#xFFFD] | [#x10000-#xEFFFF]
//[4a]   	NameChar	   ::=   	NameStartChar | "-" | "." | [0-9] | #xB7 | [#x0300-#x036F] | [#x203F-#x2040]
//[5]   	Name	   ::=   	NameStartChar (NameChar)*
var nameStartChar = /[A-Z_a-z\xC0-\xD6\xD8-\xF6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]///\u10000-\uEFFFF
var nameChar = new RegExp("[\\-\\.0-9"+nameStartChar.source.slice(1,-1)+"\\u00B7\\u0300-\\u036F\\u203F-\\u2040]");
var tagNamePattern = new RegExp('^'+nameStartChar.source+nameChar.source+'*(?:\:'+nameStartChar.source+nameChar.source+'*)?$');
//var tagNamePattern = /^[a-zA-Z_][\w\-\.]*(?:\:[a-zA-Z_][\w\-\.]*)?$/
//var handlers = 'resolveEntity,getExternalSubset,characters,endDocument,endElement,endPrefixMapping,ignorableWhitespace,processingInstruction,setDocumentLocator,skippedEntity,startDocument,startElement,startPrefixMapping,notationDecl,unparsedEntityDecl,error,fatalError,warning,attributeDecl,elementDecl,externalEntityDecl,internalEntityDecl,comment,endCDATA,endDTD,endEntity,startCDATA,startDTD,startEntity'.split(',')

//S_TAG,	S_ATTR,	S_EQ,	S_ATTR_NOQUOT_VALUE
//S_ATTR_SPACE,	S_ATTR_END,	S_TAG_SPACE, S_TAG_CLOSE
var S_TAG = 0;//tag name offerring
var S_ATTR = 1;//attr name offerring 
var S_ATTR_SPACE=2;//attr name end and space offer
var S_EQ = 3;//=space?
var S_ATTR_NOQUOT_VALUE = 4;//attr value(no quot value only)
var S_ATTR_END = 5;//attr value end and no space(quot end)
var S_TAG_SPACE = 6;//(attr value end || tag end ) && (space offer)
var S_TAG_CLOSE = 7;//closed el<el />

/**
 * Creates an error that will not be caught by XMLReader aka the SAX parser.
 *
 * @param {string} message
 * @param {any?} locator Optional, can provide details about the location in the source
 * @constructor
 */
function ParseError(message, locator) {
	this.message = message
	this.locator = locator
	if(Error.captureStackTrace) Error.captureStackTrace(this, ParseError);
}
ParseError.prototype = new Error();
ParseError.prototype.name = ParseError.name

function XMLReader(){
	
}

XMLReader.prototype = {
	parse:function(source,defaultNSMap,entityMap){
		var domBuilder = this.domBuilder;
		domBuilder.startDocument();
		_copy(defaultNSMap ,defaultNSMap = {})
		parse(source,defaultNSMap,entityMap,
				domBuilder,this.errorHandler);
		domBuilder.endDocument();
	}
}
function parse(source,defaultNSMapCopy,entityMap,domBuilder,errorHandler){
	function fixedFromCharCode(code) {
		// String.prototype.fromCharCode does not supports
		// > 2 bytes unicode chars directly
		if (code > 0xffff) {
			code -= 0x10000;
			var surrogate1 = 0xd800 + (code >> 10)
				, surrogate2 = 0xdc00 + (code & 0x3ff);

			return String.fromCharCode(surrogate1, surrogate2);
		} else {
			return String.fromCharCode(code);
		}
	}
	function entityReplacer(a){
		var k = a.slice(1,-1);
		if(k in entityMap){
			return entityMap[k]; 
		}else if(k.charAt(0) === '#'){
			return fixedFromCharCode(parseInt(k.substr(1).replace('x','0x')))
		}else{
			errorHandler.error('entity not found:'+a);
			return a;
		}
	}
	function appendText(end){//has some bugs
		if(end>start){
			var xt = source.substring(start,end).replace(/&#?\w+;/g,entityReplacer);
			locator&&position(start);
			domBuilder.characters(xt,0,end-start);
			start = end
		}
	}
	function position(p,m){
		while(p>=lineEnd && (m = linePattern.exec(source))){
			lineStart = m.index;
			lineEnd = lineStart + m[0].length;
			locator.lineNumber++;
			//console.log('line++:',locator,startPos,endPos)
		}
		locator.columnNumber = p-lineStart+1;
	}
	var lineStart = 0;
	var lineEnd = 0;
	var linePattern = /.*(?:\r\n?|\n)|.*$/g
	var locator = domBuilder.locator;
	
	var parseStack = [{currentNSMap:defaultNSMapCopy}]
	var closeMap = {};
	var start = 0;
	while(true){
		try{
			var tagStart = source.indexOf('<',start);
			if(tagStart<0){
				if(!source.substr(start).match(/^\s*$/)){
					var doc = domBuilder.doc;
	    			var text = doc.createTextNode(source.substr(start));
	    			doc.appendChild(text);
	    			domBuilder.currentElement = text;
				}
				return;
			}
			if(tagStart>start){
				appendText(tagStart);
			}
			switch(source.charAt(tagStart+1)){
			case '/':
				var end = source.indexOf('>',tagStart+3);
				var tagName = source.substring(tagStart+2,end);
				var config = parseStack.pop();
				if(end<0){
					
	        		tagName = source.substring(tagStart+2).replace(/[\s<].*/,'');
	        		errorHandler.error("end tag name: "+tagName+' is not complete:'+config.tagName);
	        		end = tagStart+1+tagName.length;
	        	}else if(tagName.match(/\s</)){
	        		tagName = tagName.replace(/[\s<].*/,'');
	        		errorHandler.error("end tag name: "+tagName+' maybe not complete');
	        		end = tagStart+1+tagName.length;
				}
				var localNSMap = config.localNSMap;
				var endMatch = config.tagName == tagName;
				var endIgnoreCaseMach = endMatch || config.tagName&&config.tagName.toLowerCase() == tagName.toLowerCase()
		        if(endIgnoreCaseMach){
		        	domBuilder.endElement(config.uri,config.localName,tagName);
					if(localNSMap){
						for(var prefix in localNSMap){
							domBuilder.endPrefixMapping(prefix) ;
						}
					}
					if(!endMatch){
		            	errorHandler.fatalError("end tag name: "+tagName+' is not match the current start tagName:'+config.tagName ); // No known test case
					}
		        }else{
		        	parseStack.push(config)
		        }
				
				end++;
				break;
				// end elment
			case '?':// <?...?>
				locator&&position(tagStart);
				end = parseInstruction(source,tagStart,domBuilder);
				break;
			case '!':// <!doctype,<![CDATA,<!--
				locator&&position(tagStart);
				end = parseDCC(source,tagStart,domBuilder,errorHandler);
				break;
			default:
				locator&&position(tagStart);
				var el = new ElementAttributes();
				var currentNSMap = parseStack[parseStack.length-1].currentNSMap;
				//elStartEnd
				var end = parseElementStartPart(source,tagStart,el,currentNSMap,entityReplacer,errorHandler);
				var len = el.length;
				
				
				if(!el.closed && fixSelfClosed(source,end,el.tagName,closeMap)){
					el.closed = true;
					if(!entityMap.nbsp){
						errorHandler.warning('unclosed xml attribute');
					}
				}
				if(locator && len){
					var locator2 = copyLocator(locator,{});
					//try{//attribute position fixed
					for(var i = 0;i<len;i++){
						var a = el[i];
						position(a.offset);
						a.locator = copyLocator(locator,{});
					}
					domBuilder.locator = locator2
					if(appendElement(el,domBuilder,currentNSMap)){
						parseStack.push(el)
					}
					domBuilder.locator = locator;
				}else{
					if(appendElement(el,domBuilder,currentNSMap)){
						parseStack.push(el)
					}
				}
				
				
				
				if(el.uri === 'http://www.w3.org/1999/xhtml' && !el.closed){
					end = parseHtmlSpecialContent(source,end,el.tagName,entityReplacer,domBuilder)
				}else{
					end++;
				}
			}
		}catch(e){
			if (e instanceof ParseError) {
				throw e;
			}
			errorHandler.error('element parse error: '+e)
			end = -1;
		}
		if(end>start){
			start = end;
		}else{
			//TODO: 这里有可能sax回退，有位置错误风险
			appendText(Math.max(tagStart,start)+1);
		}
	}
}
function copyLocator(f,t){
	t.lineNumber = f.lineNumber;
	t.columnNumber = f.columnNumber;
	return t;
}

/**
 * @see #appendElement(source,elStartEnd,el,selfClosed,entityReplacer,domBuilder,parseStack);
 * @return end of the elementStartPart(end of elementEndPart for selfClosed el)
 */
function parseElementStartPart(source,start,el,currentNSMap,entityReplacer,errorHandler){

	/**
	 * @param {string} qname
	 * @param {string} value
	 * @param {number} startIndex
	 */
	function addAttribute(qname, value, startIndex) {
		if (qname in el.attributeNames) errorHandler.fatalError('Attribute ' + qname + ' redefined')
		el.addValue(qname, value, startIndex)
	}
	var attrName;
	var value;
	var p = ++start;
	var s = S_TAG;//status
	while(true){
		var c = source.charAt(p);
		switch(c){
		case '=':
			if(s === S_ATTR){//attrName
				attrName = source.slice(start,p);
				s = S_EQ;
			}else if(s === S_ATTR_SPACE){
				s = S_EQ;
			}else{
				//fatalError: equal must after attrName or space after attrName
				throw new Error('attribute equal must after attrName'); // No known test case
			}
			break;
		case '\'':
		case '"':
			if(s === S_EQ || s === S_ATTR //|| s == S_ATTR_SPACE
				){//equal
				if(s === S_ATTR){
					errorHandler.warning('attribute value must after "="')
					attrName = source.slice(start,p)
				}
				start = p+1;
				p = source.indexOf(c,start)
				if(p>0){
					value = source.slice(start,p).replace(/&#?\w+;/g,entityReplacer);
					addAttribute(attrName, value, start-1);
					s = S_ATTR_END;
				}else{
					//fatalError: no end quot match
					throw new Error('attribute value no end \''+c+'\' match');
				}
			}else if(s == S_ATTR_NOQUOT_VALUE){
				value = source.slice(start,p).replace(/&#?\w+;/g,entityReplacer);
				//console.log(attrName,value,start,p)
				addAttribute(attrName, value, start);
				//console.dir(el)
				errorHandler.warning('attribute "'+attrName+'" missed start quot('+c+')!!');
				start = p+1;
				s = S_ATTR_END
			}else{
				//fatalError: no equal before
				throw new Error('attribute value must after "="'); // No known test case
			}
			break;
		case '/':
			switch(s){
			case S_TAG:
				el.setTagName(source.slice(start,p));
			case S_ATTR_END:
			case S_TAG_SPACE:
			case S_TAG_CLOSE:
				s =S_TAG_CLOSE;
				el.closed = true;
			case S_ATTR_NOQUOT_VALUE:
			case S_ATTR:
			case S_ATTR_SPACE:
				break;
			//case S_EQ:
			default:
				throw new Error("attribute invalid close char('/')") // No known test case
			}
			break;
		case ''://end document
			errorHandler.error('unexpected end of input');
			if(s == S_TAG){
				el.setTagName(source.slice(start,p));
			}
			return p;
		case '>':
			switch(s){
			case S_TAG:
				el.setTagName(source.slice(start,p));
			case S_ATTR_END:
			case S_TAG_SPACE:
			case S_TAG_CLOSE:
				break;//normal
			case S_ATTR_NOQUOT_VALUE://Compatible state
			case S_ATTR:
				value = source.slice(start,p);
				if(value.slice(-1) === '/'){
					el.closed  = true;
					value = value.slice(0,-1)
				}
			case S_ATTR_SPACE:
				if(s === S_ATTR_SPACE){
					value = attrName;
				}
				if(s == S_ATTR_NOQUOT_VALUE){
					errorHandler.warning('attribute "'+value+'" missed quot(")!');
					addAttribute(attrName, value.replace(/&#?\w+;/g,entityReplacer), start)
				}else{
					if(currentNSMap[''] !== 'http://www.w3.org/1999/xhtml' || !value.match(/^(?:disabled|checked|selected)$/i)){
						errorHandler.warning('attribute "'+value+'" missed value!! "'+value+'" instead!!')
					}
					addAttribute(value, value, start)
				}
				break;
			case S_EQ:
				throw new Error('attribute value missed!!');
			}
//			console.log(tagName,tagNamePattern,tagNamePattern.test(tagName))
			return p;
		/*xml space '\x20' | #x9 | #xD | #xA; */
		case '\u0080':
			c = ' ';
		default:
			if(c<= ' '){//space
				switch(s){
				case S_TAG:
					el.setTagName(source.slice(start,p));//tagName
					s = S_TAG_SPACE;
					break;
				case S_ATTR:
					attrName = source.slice(start,p)
					s = S_ATTR_SPACE;
					break;
				case S_ATTR_NOQUOT_VALUE:
					var value = source.slice(start,p).replace(/&#?\w+;/g,entityReplacer);
					errorHandler.warning('attribute "'+value+'" missed quot(")!!');
					addAttribute(attrName, value, start)
				case S_ATTR_END:
					s = S_TAG_SPACE;
					break;
				//case S_TAG_SPACE:
				//case S_EQ:
				//case S_ATTR_SPACE:
				//	void();break;
				//case S_TAG_CLOSE:
					//ignore warning
				}
			}else{//not space
//S_TAG,	S_ATTR,	S_EQ,	S_ATTR_NOQUOT_VALUE
//S_ATTR_SPACE,	S_ATTR_END,	S_TAG_SPACE, S_TAG_CLOSE
				switch(s){
				//case S_TAG:void();break;
				//case S_ATTR:void();break;
				//case S_ATTR_NOQUOT_VALUE:void();break;
				case S_ATTR_SPACE:
					var tagName =  el.tagName;
					if(currentNSMap[''] !== 'http://www.w3.org/1999/xhtml' || !attrName.match(/^(?:disabled|checked|selected)$/i)){
						errorHandler.warning('attribute "'+attrName+'" missed value!! "'+attrName+'" instead2!!')
					}
					addAttribute(attrName, attrName, start);
					start = p;
					s = S_ATTR;
					break;
				case S_ATTR_END:
					errorHandler.warning('attribute space is required"'+attrName+'"!!')
				case S_TAG_SPACE:
					s = S_ATTR;
					start = p;
					break;
				case S_EQ:
					s = S_ATTR_NOQUOT_VALUE;
					start = p;
					break;
				case S_TAG_CLOSE:
					throw new Error("elements closed character '/' and '>' must be connected to");
				}
			}
		}//end outer switch
		//console.log('p++',p)
		p++;
	}
}
/**
 * @return true if has new namespace define
 */
function appendElement(el,domBuilder,currentNSMap){
	var tagName = el.tagName;
	var localNSMap = null;
	//var currentNSMap = parseStack[parseStack.length-1].currentNSMap;
	var i = el.length;
	while(i--){
		var a = el[i];
		var qName = a.qName;
		var value = a.value;
		var nsp = qName.indexOf(':');
		if(nsp>0){
			var prefix = a.prefix = qName.slice(0,nsp);
			var localName = qName.slice(nsp+1);
			var nsPrefix = prefix === 'xmlns' && localName
		}else{
			localName = qName;
			prefix = null
			nsPrefix = qName === 'xmlns' && ''
		}
		//can not set prefix,because prefix !== ''
		a.localName = localName ;
		//prefix == null for no ns prefix attribute 
		if(nsPrefix !== false){//hack!!
			if(localNSMap == null){
				localNSMap = {}
				//console.log(currentNSMap,0)
				_copy(currentNSMap,currentNSMap={})
				//console.log(currentNSMap,1)
			}
			currentNSMap[nsPrefix] = localNSMap[nsPrefix] = value;
			a.uri = 'http://www.w3.org/2000/xmlns/'
			domBuilder.startPrefixMapping(nsPrefix, value) 
		}
	}
	var i = el.length;
	while(i--){
		a = el[i];
		var prefix = a.prefix;
		if(prefix){//no prefix attribute has no namespace
			if(prefix === 'xml'){
				a.uri = 'http://www.w3.org/XML/1998/namespace';
			}if(prefix !== 'xmlns'){
				a.uri = currentNSMap[prefix || '']
				
				//{console.log('###'+a.qName,domBuilder.locator.systemId+'',currentNSMap,a.uri)}
			}
		}
	}
	var nsp = tagName.indexOf(':');
	if(nsp>0){
		prefix = el.prefix = tagName.slice(0,nsp);
		localName = el.localName = tagName.slice(nsp+1);
	}else{
		prefix = null;//important!!
		localName = el.localName = tagName;
	}
	//no prefix element has default namespace
	var ns = el.uri = currentNSMap[prefix || ''];
	domBuilder.startElement(ns,localName,tagName,el);
	//endPrefixMapping and startPrefixMapping have not any help for dom builder
	//localNSMap = null
	if(el.closed){
		domBuilder.endElement(ns,localName,tagName);
		if(localNSMap){
			for(prefix in localNSMap){
				domBuilder.endPrefixMapping(prefix) 
			}
		}
	}else{
		el.currentNSMap = currentNSMap;
		el.localNSMap = localNSMap;
		//parseStack.push(el);
		return true;
	}
}
function parseHtmlSpecialContent(source,elStartEnd,tagName,entityReplacer,domBuilder){
	if(/^(?:script|textarea)$/i.test(tagName)){
		var elEndStart =  source.indexOf('</'+tagName+'>',elStartEnd);
		var text = source.substring(elStartEnd+1,elEndStart);
		if(/[&<]/.test(text)){
			if(/^script$/i.test(tagName)){
				//if(!/\]\]>/.test(text)){
					//lexHandler.startCDATA();
					domBuilder.characters(text,0,text.length);
					//lexHandler.endCDATA();
					return elEndStart;
				//}
			}//}else{//text area
				text = text.replace(/&#?\w+;/g,entityReplacer);
				domBuilder.characters(text,0,text.length);
				return elEndStart;
			//}
			
		}
	}
	return elStartEnd+1;
}
function fixSelfClosed(source,elStartEnd,tagName,closeMap){
	//if(tagName in closeMap){
	var pos = closeMap[tagName];
	if(pos == null){
		//console.log(tagName)
		pos =  source.lastIndexOf('</'+tagName+'>')
		if(pos<elStartEnd){//忘记闭合
			pos = source.lastIndexOf('</'+tagName)
		}
		closeMap[tagName] =pos
	}
	return pos<elStartEnd;
	//} 
}
function _copy(source,target){
	for(var n in source){target[n] = source[n]}
}
function parseDCC(source,start,domBuilder,errorHandler){//sure start with '<!'
	var next= source.charAt(start+2)
	switch(next){
	case '-':
		if(source.charAt(start + 3) === '-'){
			var end = source.indexOf('-->',start+4);
			//append comment source.substring(4,end)//<!--
			if(end>start){
				domBuilder.comment(source,start+4,end-start-4);
				return end+3;
			}else{
				errorHandler.error("Unclosed comment");
				return -1;
			}
		}else{
			//error
			return -1;
		}
	default:
		if(source.substr(start+3,6) == 'CDATA['){
			var end = source.indexOf(']]>',start+9);
			domBuilder.startCDATA();
			domBuilder.characters(source,start+9,end-start-9);
			domBuilder.endCDATA() 
			return end+3;
		}
		//<!DOCTYPE
		//startDTD(java.lang.String name, java.lang.String publicId, java.lang.String systemId) 
		var matchs = split(source,start);
		var len = matchs.length;
		if(len>1 && /!doctype/i.test(matchs[0][0])){
			var name = matchs[1][0];
			var pubid = false;
			var sysid = false;
			if(len>3){
				if(/^public$/i.test(matchs[2][0])){
					pubid = matchs[3][0];
					sysid = len>4 && matchs[4][0];
				}else if(/^system$/i.test(matchs[2][0])){
					sysid = matchs[3][0];
				}
			}
			var lastMatch = matchs[len-1]
			domBuilder.startDTD(name, pubid, sysid);
			domBuilder.endDTD();
			
			return lastMatch.index+lastMatch[0].length
		}
	}
	return -1;
}



function parseInstruction(source,start,domBuilder){
	var end = source.indexOf('?>',start);
	if(end){
		var match = source.substring(start,end).match(/^<\?(\S*)\s*([\s\S]*?)\s*$/);
		if(match){
			var len = match[0].length;
			domBuilder.processingInstruction(match[1], match[2]) ;
			return end+2;
		}else{//error
			return -1;
		}
	}
	return -1;
}

function ElementAttributes(){
	this.attributeNames = {}
}
ElementAttributes.prototype = {
	setTagName:function(tagName){
		if(!tagNamePattern.test(tagName)){
			throw new Error('invalid tagName:'+tagName)
		}
		this.tagName = tagName
	},
	addValue:function(qName, value, offset) {
		if(!tagNamePattern.test(qName)){
			throw new Error('invalid attribute:'+qName)
		}
		this.attributeNames[qName] = this.length;
		this[this.length++] = {qName:qName,value:value,offset:offset}
	},
	length:0,
	getLocalName:function(i){return this[i].localName},
	getLocator:function(i){return this[i].locator},
	getQName:function(i){return this[i].qName},
	getURI:function(i){return this[i].uri},
	getValue:function(i){return this[i].value}
//	,getIndex:function(uri, localName)){
//		if(localName){
//			
//		}else{
//			var qName = uri
//		}
//	},
//	getValue:function(){return this.getValue(this.getIndex.apply(this,arguments))},
//	getType:function(uri,localName){}
//	getType:function(i){},
}



function split(source,start){
	var match;
	var buf = [];
	var reg = /'[^']+'|"[^"]+"|[^\s<>\/=]+=?|(\/?\s*>|<)/g;
	reg.lastIndex = start;
	reg.exec(source);//skip <
	while(match = reg.exec(source)){
		buf.push(match);
		if(match[1])return buf;
	}
}

exports.XMLReader = XMLReader;
exports.ParseError = ParseError;

},{}],56:[function(require,module,exports){
const { Buffer } = require("buffer");
const { readOcad, ocadToSvg } = require("ocad2geojson");

const MAX_RASTER_DIMENSION = 6000;
const REFERENCE_MAP_SCALE = 4000;
const REFERENCE_METERS_PER_PIXEL = 0.48;
const OCAD_UNITS_PER_METER_ON_PAPER = 100 * 1000;
const RUN_SPEED = 4.75;
const PX_TO_M = 0.48;
const NOA_CLUSTER_WINDOW_M = 20;
const NOA_COUNTER_TURN_WINDOW_M = 10;
const NOA_ARTIFACT_WINDOW_M = 3;
const NOA_MIN_SEGMENT_M = 1.5;
const NOA_CORNER_DEG = 60;
const NOA_EPSILON_DEG = 2;
const NOA_MIN_EFFECT_DEG = 30;
const NOA_COUNTER_MIN_DEG = 30;
const ROUTE_POINT_MIN_DISTANCE = 2;
const COURSE_DISPLAY_EXCLUDED_SYMS = new Set([
  701000,
  702000,
  703000,
  704000,
  704001,
  705000,
  706000,
  707000,
  720000,
  721000,
  760000,
  10602010,
]);

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseObjectString(objectString) {
  const result = {};
  const parts = String(objectString || "").split("\t").filter(Boolean);
  if (parts.length) result._first = parts[0];
  for (const part of parts.slice(1)) {
    const key = part.slice(0, 1);
    const value = part.slice(1);
    if (!key) continue;
    if (result[key] === undefined) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

function coordinateToPixel(coord, bounds, scale) {
  const x = Number(coord[0]);
  const y = Number(coord[1]);
  return {
    x: Math.round((x - bounds[0]) * scale * 100) / 100,
    y: Math.round((bounds[3] - y) * scale * 100) / 100,
  };
}

function scalePoint(point, scale) {
  return {
    x: Math.round(point.x * scale * 100) / 100,
    y: Math.round(point.y * scale * 100) / 100,
  };
}

function coordinateToEditorPixel(coord, bounds, rasterScale, editorScale) {
  return scalePoint(coordinateToPixel(coord, bounds, rasterScale), editorScale);
}

function getOcadMapScale(ocadFile) {
  const crs = ocadFile.getCrs();
  const scale = Number(crs.scale);
  return Number.isFinite(scale) && scale > 1 ? scale : REFERENCE_MAP_SCALE;
}

function computeEditorScale(mapScale, rasterScale, calibrationFactor) {
  const metersPerRasterPixel = mapScale / OCAD_UNITS_PER_METER_ON_PAPER / rasterScale;
  return (
    metersPerRasterPixel *
    REFERENCE_MAP_SCALE /
    mapScale /
    REFERENCE_METERS_PER_PIXEL *
    calibrationFactor
  );
}

function isCourseDisplayObject(object) {
  return COURSE_DISPLAY_EXCLUDED_SYMS.has(Number(object.sym));
}

function makeRenderableObjectFilter(ocadFile) {
  const symbolByNumber = new Map((ocadFile.symbols || []).map((symbol) => [Number(symbol.symNum), symbol]));
  return (object) => {
    if (isCourseDisplayObject(object)) return false;
    if (isActualRouteObject(object, symbolByNumber)) return false;
    const symbol = symbolByNumber.get(Number(object.sym));
    return !symbol || Number(symbol.status || 0) === 0;
  };
}

function extractControlPoints(ocadFile, bounds, rasterScale, editorScale) {
  const points = {};

  for (const object of ocadFile.objects || []) {
    if (!object.objectString || !object.coordinates?.length) continue;
    const parsed = parseObjectString(object.objectString);
    const id = firstValue(parsed.a);
    const kind = firstValue(parsed.Y);
    if (!id || points[id]) continue;

    const coord = object.coordinates[0];
    const rasterPixel = coordinateToPixel(coord, bounds, rasterScale);
    points[id] = {
      id,
      kind: kind || "",
      sym: object.sym,
      raw: { x: Number(coord[0]), y: Number(coord[1]) },
      raster_pixel: rasterPixel,
      pixel: scalePoint(rasterPixel, editorScale),
      objectString: object.objectString,
    };
  }

  return points;
}

function extractCourses(ocadFile) {
  const courseEntries = ocadFile.parameterStrings?.["2"] || [];
  return courseEntries.map((entry) => ({
    name: entry._first || "",
    start: firstValue(entry.s) || null,
    controls: normalizeList(entry.c),
    markedRoutes: normalizeList(entry.m),
    finish: firstValue(entry.f) || null,
    tokens: (entry._pairs || [])
      .filter((pair) => ["s", "c", "m", "f"].includes(pair.code))
      .map((pair) => ({ code: pair.code, value: pair.value })),
    climb: entry.C || null,
  }));
}

function buildCourseLegs(course) {
  const legs = [];
  let from = null;
  let marked = [];

  for (const token of course.tokens || []) {
    if (token.code === "m") {
      if (token.value) marked.push(token.value);
      continue;
    }
    if (!["s", "c", "f"].includes(token.code) || !token.value) continue;
    if (from) legs.push({ from, to: token.value, markedRoutes: marked });
    from = token.value;
    marked = [];
  }

  return legs;
}

function routePointKey(point) {
  return `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`;
}

function appendRoutePoints(target, points) {
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const prev = target[target.length - 1];
    if (prev && Math.hypot(prev.x - point.x, prev.y - point.y) < ROUTE_POINT_MIN_DISTANCE) continue;
    target.push(point);
  }
}

function calcRouteLength(route) {
  const pts = route.rP;
  if (!pts || pts.length < 2) {
    route.length = 0;
    return;
  }
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * PX_TO_M;
  }
  route.length = Math.round(total);
}

function normalizeTurnRad(angle) {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

function roundNoA(value) {
  return Math.round(value * 10) / 10;
}

function simplifiedNoAPoints(points) {
  const minStep = NOA_MIN_SEGMENT_M / PX_TO_M;
  const out = [];
  for (const point of points || []) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    const current = { x: point.x, y: point.y };
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(current.x - prev.x, current.y - prev.y) >= minStep) out.push(current);
  }
  const last = points?.[points.length - 1];
  if (out.length && last && Number.isFinite(last.x) && Number.isFinite(last.y)) {
    out[out.length - 1] = { x: last.x, y: last.y };
  }
  return out;
}

function calcRouteNoA(route, scale) {
  const rP = simplifiedNoAPoints(route.rP);
  if (!rP || rP.length < 3) {
    route.noA = 0;
    return;
  }

  const epsRad = (NOA_EPSILON_DEG * Math.PI) / 180;
  const cum = [0];
  const headings = [];
  const segLen = [];

  for (let i = 1; i < rP.length; i++) {
    const dx = rP[i].x - rP[i - 1].x;
    const dy = rP[i].y - rP[i - 1].y;
    const len = Math.hypot(dx, dy) * PX_TO_M;
    cum.push(cum[i - 1] + len);
    segLen.push(len);
    headings.push(dx === 0 && dy === 0 ? null : Math.atan2(dy, dx));
  }

  const turns = [];
  for (let i = 1; i < headings.length; i++) {
    const h1 = headings[i - 1];
    const h2 = headings[i];
    if (h1 === null || h2 === null) continue;
    const signed = normalizeTurnRad(h2 - h1);
    const abs = Math.abs(signed);
    if (abs < epsRad) continue;
    if (Math.min(segLen[i - 1], segLen[i]) < NOA_MIN_SEGMENT_M) continue;
    turns.push({ pos: cum[i], signedDeg: (signed * 180) / Math.PI, absDeg: (abs * 180) / Math.PI });
  }

  let noA = 0;
  for (let i = 0; i < turns.length;) {
    const cluster = [turns[i++]];
    while (i < turns.length && turns[i].pos - cluster[0].pos <= NOA_CLUSTER_WINDOW_M) {
      cluster.push(turns[i++]);
    }

    const span = cluster[cluster.length - 1].pos - cluster[0].pos;
    const totalAbs = cluster.reduce((sum, turn) => sum + turn.absDeg, 0);
    const net = Math.abs(cluster.reduce((sum, turn) => sum + turn.signedDeg, 0));
    const maxTurn = Math.max(...cluster.map((turn) => turn.absDeg));
    if (span <= NOA_ARTIFACT_WINDOW_M && net < NOA_MIN_EFFECT_DEG && totalAbs >= NOA_CORNER_DEG) continue;

    const directionDeg = Math.max(maxTurn, net);
    if (directionDeg >= NOA_MIN_EFFECT_DEG || totalAbs >= NOA_CORNER_DEG) {
      noA += directionDeg / NOA_CORNER_DEG;
    }

    let counterDeg = 0;
    for (let j = 0; j < cluster.length; j++) {
      let localAbs = 0;
      let localNet = 0;
      for (let k = j; k < cluster.length; k++) {
        if (cluster[k].pos - cluster[j].pos > NOA_COUNTER_TURN_WINDOW_M) break;
        localAbs += cluster[k].absDeg;
        localNet += cluster[k].signedDeg;
      }
      counterDeg = Math.max(counterDeg, localAbs - Math.abs(localNet));
    }
    if (counterDeg >= NOA_COUNTER_MIN_DEG) {
      noA += counterDeg / (2 * NOA_CORNER_DEG);
    }
  }

  route.noA = roundNoA(noA);
}

function calcRouteRunTime(route) {
  const length = route.length;
  const elevation = route.elevation;
  if (length == null || length === 0) {
    route.run_time = null;
    return;
  }
  const noAPenalty = route.noA || 0;
  if (!elevation) {
    route.run_time = length / RUN_SPEED + noAPenalty;
    return;
  }
  const gradient = (elevation / length) * 100;
  const gapUp = 0.0017 * gradient ** 2 + 0.02901 * gradient + 0.99387;
  const gapDown = 0.0017 * gradient ** 2 - 0.02901 * gradient + 0.99387;
  const adjSpeed = RUN_SPEED / ((gapUp + gapDown) / 2);
  route.run_time = length / adjSpeed + noAPenalty;
}

function calcRouteSide(cp, route) {
  const rP = route.rP;
  if (!rP?.length || !cp.start || !cp.ziel) {
    route.pos = null;
    return;
  }
  const dx = cp.ziel.x - cp.start.x;
  const dy = cp.ziel.y - cp.start.y;
  let sum = 0;
  for (const p of rP) {
    sum += dx * (p.y - cp.start.y) - dy * (p.x - cp.start.x);
  }
  route.pos = sum / rP.length;
}

function makeRoute(rP, cp, order, scale, source) {
  const route = {
    id: null,
    order,
    rP,
    noA: null,
    pos: null,
    length: null,
    run_time: null,
    elevation: 0,
    source,
  };
  calcRouteLength(route);
  calcRouteNoA(route, scale);
  calcRouteRunTime(route);
  calcRouteSide(cp, route);
  return route;
}

function isActualRouteObject(object, symbolByNumber) {
  const sym = Number(object.sym);
  if (sym === 10602010) return true;
  const symbol = symbolByNumber.get(sym);
  if (!symbol || Number(symbol.type) !== 2) return false;
  // Covers "Fastest route", "Shortest Route", "Alternative Routes", etc.
  return /\broutes?\b/i.test(symbol.description || "");
}

function buildActualRouteIndex(ocadFile, bounds, rasterScale, editorScale) {
  const segments = new Map();
  const symbolByNumber = new Map((ocadFile.symbols || []).map((symbol) => [Number(symbol.symNum), symbol]));

  for (const object of ocadFile.objects || []) {
    if (!isActualRouteObject(object, symbolByNumber)) continue;
    const parsed = parseObjectString(object.objectString);
    const points = (object.coordinates || [])
      .map((coord) => coordinateToEditorPixel(coord, bounds, rasterScale, editorScale));
    const from = firstValue(parsed.f);
    const to = firstValue(parsed.t);
    if (!from || !to || points.length < 2) continue;
    const key = `${from}->${to}`;
    if (!segments.has(key)) segments.set(key, []);
    segments.get(key).push({
      routeOrder: Number(parsed._first || 0),
      from,
      to,
      points,
      objectString: object.objectString || "",
      label: firstValue(parsed.n) || "",
      rawLengthTime: firstValue(parsed.c) || "",
    });
  }

  return { segments };
}

function findActualRouteSegment(index, from, to) {
  const entries = index.segments.get(`${from}->${to}`) || [];
  return entries[0] || null;
}

function buildLegPolyline(leg, course, points, routeIndex) {
  const start = points[leg.from];
  const end = points[leg.to];
  if (!start || !end) return null;

  const rP = [];
  appendRoutePoints(rP, [start.pixel]);

  let cursor = leg.from;
  let matchedSegments = 0;
  for (const markedId of leg.markedRoutes || []) {
    const entry = findActualRouteSegment(routeIndex, cursor, markedId);
    if (entry) {
      appendRoutePoints(rP, entry.points);
      matchedSegments++;
    }
    cursor = markedId;
  }

  const exit = findActualRouteSegment(routeIndex, cursor, leg.to);
  if (exit) {
    appendRoutePoints(rP, exit.points);
    matchedSegments++;
  }
  if (!matchedSegments) return null;
  appendRoutePoints(rP, [end.pixel]);

  return rP.length >= 2 ? rP : null;
}

function routeGeometryKey(rP) {
  return rP.map(routePointKey).join("|");
}

function buildControlPairs(courses, points, routeIndex, editorScale) {
  const seen = new Set();
  const byLeg = new Map();
  const controlPairs = [];

  for (const course of courses) {
    for (const leg of buildCourseLegs(course)) {
      const { from, to } = leg;
      if (!points[from] || !points[to]) continue;
      const key = `${from}->${to}`;
      let cp = byLeg.get(key);
      if (!cp) {
        if (seen.has(key)) continue;
        seen.add(key);
        cp = {
          order: controlPairs.length,
          start: points[from].pixel,
          ziel: points[to].pixel,
          complex: false,
          routes: [],
          source: {
            from,
            to,
            first_course: course.name,
          },
          _routeKeys: new Set(),
        };
        byLeg.set(key, cp);
        controlPairs.push(cp);
      }

      const rP = buildLegPolyline(leg, course, points, routeIndex);
      if (!rP) continue;
      const routeKey = routeGeometryKey(rP);
      if (cp._routeKeys.has(routeKey)) continue;
      cp._routeKeys.add(routeKey);
      cp.routes.push(makeRoute(rP, cp, cp.routes.length, editorScale, {
        course: course.name,
        from,
        to,
        marked_routes: leg.markedRoutes || [],
      }));
      if (cp.routes.length > 1) cp.complex = true;
    }
  }

  for (const cp of controlPairs) delete cp._routeKeys;
  return controlPairs;
}

async function getControlsInfo(file) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const ocadFile = await readOcad(buffer);
  const bounds = ocadFile.getBounds();
  const controlPoints = extractControlPoints(ocadFile, bounds, 1, 1);
  const courses = extractCourses(ocadFile);
  const routeIndex = buildActualRouteIndex(ocadFile, bounds, 1, 1);
  const controlPairs = buildControlPairs(courses, controlPoints, routeIndex, 1);

  return {
    hasControls: controlPairs.length > 0,
    hasRoutes: controlPairs.some((cp) => Array.isArray(cp.routes) && cp.routes.length > 0),
  };
}

async function renderSvgPreview(file, options = {}) {
  const calibrationFactor = Number(options.scaleFactor || 1);
  const buffer = Buffer.from(await file.arrayBuffer());
  const ocadFile = await readOcad(buffer);
  const mapScale = getOcadMapScale(ocadFile);
  const bounds = ocadFile.getBounds();
  const widthUnits = bounds[2] - bounds[0];
  const heightUnits = bounds[3] - bounds[1];
  const rasterScale = Math.min(
    MAX_RASTER_DIMENSION / widthUnits,
    MAX_RASTER_DIMENSION / heightUnits
  );
  const editorScale = computeEditorScale(mapScale, rasterScale, calibrationFactor);
  const metersPerRasterPixel = mapScale / OCAD_UNITS_PER_METER_ON_PAPER / rasterScale;
  const width = Math.max(1, Math.round(widthUnits * rasterScale));
  const height = Math.max(1, Math.round(heightUnits * rasterScale));
  const objects = (ocadFile.objects || []).filter(makeRenderableObjectFilter(ocadFile));
  const svg = ocadToSvg(ocadFile, {
    document,
    exportHidden: true,
    objects,
    fill: "transparent",
  });
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", String(bounds[0]));
  background.setAttribute("y", String(bounds[1]));
  background.setAttribute("width", String(widthUnits));
  background.setAttribute("height", String(heightUnits));
  background.setAttribute("fill", "#ffffff");
  svg.insertBefore(background, svg.querySelector("g"));

  svg.setAttribute("id", "map-svg-preview");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  svg.style.display = "block";
  svg.style.background = "#ffffff";
  svg.style.pointerEvents = "none";
  svg.style.userSelect = "none";

  const controlPoints = extractControlPoints(ocadFile, bounds, rasterScale, editorScale);
  const courses = extractCourses(ocadFile);
  const routeIndex = buildActualRouteIndex(ocadFile, bounds, rasterScale, editorScale);
  const controlPairs = buildControlPairs(courses, controlPoints, routeIndex, editorScale);
  const actualRouteSegments = Array.from(routeIndex.segments.values())
    .reduce((sum, entries) => sum + entries.length, 0);

  return {
    svg,
    width,
    height,
    scale: editorScale,
    scaled: true,
    control_pairs: controlPairs,
    ocad: {
      courses: courses.length,
      controls: Object.keys(controlPoints).length,
      width,
      height,
      map_scale: mapScale,
      scale_calibration_factor: calibrationFactor,
      meters_per_raster_pixel: metersPerRasterPixel,
      actual_route_segments: actualRouteSegments,
    },
  };
}

window.OcadBrowser = {
  renderSvgPreview,
  getControlsInfo,
};

},{"buffer":16,"ocad2geojson":19}]},{},[56]);

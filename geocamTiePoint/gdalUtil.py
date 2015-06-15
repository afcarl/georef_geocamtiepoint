
import os
import logging

import numpy as np
import numpy.linalg
from osgeo import gdal, osr
import pyproj


def dosys(cmd):
    logging.info('running: %s', cmd)
    ret = os.system(cmd)
    if ret != 0:
        logging.warn('command exited with non-zero return value %s', ret)
    return ret


def getGeoTransform(gdalImageHandle):
    # return gdalImageHandle.GetGeoTransform()
    (x0, dx, rotX, y0, rotY, dy) = gdalImageHandle.GetGeoTransform()
    assert rotX == 0
    assert rotY == 0
    return np.array([[dx, 0, x0],
                     [0, dy, y0]])


def applyGeoTransformAug(geoTransform, mapPixelsAug):
    return np.dot(geoTransform, mapPixelsAug)


def applyGeoTransform(geoTransform, mapPixels):
    n = mapPixels.shape[1]
    mapPixelsAug = np.vstack([mapPixels, np.ones(n)])
    return applyGeoTransformAug(geoTransform, mapPixelsAug)


def invertGeoTransform(M):
    MAug = np.vstack([M, np.array([0, 0, 1])])
    inverseAug = numpy.linalg.inv(MAug)
    inverse = inverseAug[:2, :]
    return inverse


def getMapProj(gdalImageHandle):
    srsWkt = gdalImageHandle.GetProjection()
    srs = osr.SpatialReference()
    srs.ImportFromWkt(srsWkt)
    srsProj4 = srs.ExportToProj4()
    return pyproj.Proj(srsProj4)


class GdalImage(object):
    def __init__(self, gdalImageHandle):
        self.gdalImageHandle = gdalImageHandle
        self.geoTransform = getGeoTransform(gdalImageHandle)
        self.inv = invertGeoTransform(self.geoTransform)
        self.mapProj = getMapProj(gdalImageHandle)

    def mapProjectedCoordsFromMapPixels(self, mapPixel):
        return applyGeoTransform(self.geoTransform, mapPixel)

    def mapPixelsFromMapProjectedCoords(self, projectedCoords):
        return applyGeoTransform(self.inv, projectedCoords)

    def lonLatAltsFromMapProjectedCoords(self, projectedCoords):
        pcx, pcy = projectedCoords
        lon, lat = self.mapProj(pcx, pcy, inverse=True)
        n = projectedCoords.shape[1]
        alt = np.zeros(n)
        return np.vstack([lon, lat, alt])

    def mapProjectedCoordsFromLonLatAlts(self, lonLatAlt):
        lon, lat, _ = lonLatAlt
        x, y = self.mapProj(lon, lat)
        return np.vstack([x, y])

    def lonLatAltsFromMapPixels(self, mapPixel):
        return (self.lonLatAltsFromMapProjectedCoords
                (self.mapProjectedCoordsFromMapPixels(mapPixel)))

    def mapPixelsFromLonLatAlts(self, lonLatAlt):
        return (self.mapPixelsFromMapProjectedCoords
                (self.mapProjectedCoordsFromLonLatAlts(lonLatAlt)))

    def getShape(self):
        return (self.gdalImageHandle.RasterXSize,
                self.gdalImageHandle.RasterYSize)

    def getCenterLonLatAlt(self):
        w, h = self.getShape()
        cx = float(w) / 2
        cy = float(h) / 2
        pix = np.array([[cx], [cy]])
        return self.lonLatAltsFromMapPixels(pix)


def buildVrtWithRpcMetadata(imgPath, rpcMetadata):
    noSuffix = os.path.splitext(imgPath)[0]
    geotiffName = noSuffix + '_rpc.tif'
    # make a bogus geotiff with same image contents so gdalbuildvrt will build a vrt for us
    dosys('gdal_translate -a_srs "+proj=latlong" -a_ullr -30 30 30 -30 %s %s'
          % (imgPath, geotiffName))

    # create raw vrt
    vrt0Name = noSuffix + '_rpc0.vrt'
    dosys('gdalbuildvrt %s %s' % (vrt0Name, geotiffName))

    # edit vrt -- delete srs and geoTransform sections, add RPC metadata
    vrtName = noSuffix + '_rpc.vrt'
    vrt0 = open(vrt0Name, 'r').read().splitlines()
    startTag, srs, geoTransform = vrt0[:3]
    rest = vrt0[3:]
    with open(vrtName, 'w') as vrtOut:
        vrtOut.write(startTag + '\n')
        vrtOut.write(rpcMetadata)
        vrtOut.write('\n'.join(rest) + '\n')

    return vrtName


GOOGLE_MAPS_SRS = '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +a=6378137 +b=6378137 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'


def reprojectWithRpcMetadata(inputPath, inputRpcMetadata, outputSrs, outputPath):
    # TODO: need to explicitly specify bounding box for output using gdalwarp's option -te
    #   Without that, the command below may fail when trying to calculate bounds for
    #   wide-angle photos that include space as well as ground in the image frame.
    vrtPath = buildVrtWithRpcMetadata(inputPath, inputRpcMetadata)
    dosys('gdalwarp -r lanczos -rpc -t_srs "%s" %s %s' % (outputSrs, vrtPath, outputPath))

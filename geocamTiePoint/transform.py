# __BEGIN_LICENSE__
# Copyright (C) 2008-2010 United States Government as represented by
# the Administrator of the National Aeronautics and Space Administration.
# All Rights Reserved.
# __END_LICENSE__

# warnings about undefined variables within closures
# pylint: disable=E1120

# warnings about not calling parent class constructor
# pylint: disable=W0231

# warnings about not defining abstract methods from parent
# pylint: disable=W0223

import math
import numpy
import logging
from geocamTiePoint.optimize import optimize
from geocamUtil import imageInfo
from geocamUtil.registration import imageCoordToEcef, rotMatrixFromEcefToCamera
from geocamUtil.geomath import transformEcefToLonLatAlt, transformLonLatAltToEcef

ORIGIN_SHIFT = 2 * math.pi * (6378137 / 2.)
TILE_SIZE = 256.
INITIAL_RESOLUTION = 2 * math.pi * 6378137 / TILE_SIZE


def lonLatToMeters(lonLat):
    lon, lat = lonLat
    mx = lon * ORIGIN_SHIFT / 180
    my = math.log(math.tan((90 + lat) * math.pi / 360)) / (math.pi / 180)
    my = my * ORIGIN_SHIFT / 180
    return mx, my


def metersToLatLon(mercatorPt):
    x, y = mercatorPt
    lon = x * 180 / ORIGIN_SHIFT
    lat = y * 180 / ORIGIN_SHIFT
    lat = ((math.atan(math.exp((lat * (math.pi / 180)))) * 360) / math.pi) - 90
    return lon, lat


def resolution(zoom):
    return INITIAL_RESOLUTION / (2 ** zoom)


def pixelsToMeters(x, y, zoom):
    res = resolution(zoom)
    mx = (x * res) - ORIGIN_SHIFT
    my = -(y * res) + ORIGIN_SHIFT
    return [mx, my]


def metersToPixels(x, y, zoom):
    res = resolution(zoom)
    px = (x + ORIGIN_SHIFT) / res
    py = (-y + ORIGIN_SHIFT) / res
    return [px, py]


def getProjectiveInverse(matrix):
    # http://www.cis.rit.edu/class/simg782/lectures/lecture_02/lec782_05_02.pdf (p. 33)
    c0 = matrix[0, 0]
    c1 = matrix[0, 1]
    c2 = matrix[0, 2]
    c3 = matrix[1, 0]
    c4 = matrix[1, 1]
    c5 = matrix[1, 2]
    c6 = matrix[2, 0]
    c7 = matrix[2, 1]
    result = numpy.array([[c4 - c5 * c7,
                           c2 * c7 - c1,
                           c1 * c5 - c2 * c4],
                          [c5 * c6 - c3,
                           c0 - c2 * c6,
                           c3 * c2 - c0 * c5],
                          [c3 * c7 - c4 * c6,
                           c1 * c6 - c0 * c7,
                           c0 * c4 - c1 * c3]])
    # normalize just for the hell of it
    result /= result[2, 2]
    return result


def closest(tgt, vals):
    return min(vals, key=lambda v: abs(tgt - v))


def solveQuad(a, p):
    """
    Solve p = x + a x^2 for x. Over the region of interest there should
    generally be two real roots with one much closer to p than the
    other, and we prefer that one.
    """

    if a * a > 1e-20:
        discriminant = 4 * a * p + 1
        if discriminant < 0:
            return None
        h = math.sqrt(discriminant)
        roots = [(-1 + h) / (2 * a),
                 (-1 - h) / (2 * a)]
        return closest(p, roots)
    else:
        # avoid divide by zero
        return p


class Transform(object):
    @classmethod
    def fit(cls, toPts, fromPts):
        params0 = cls.getInitParams(toPts, fromPts)
        # lambada is a function that takes "params" as argument
        # and returns the toPts calculated from fromPts and params.
        params = optimize(toPts.flatten(),
                          lambda params: forwardPts(cls.fromParams(params), fromPts).flatten(),
                          params0)
        
        return cls.fromParams(params)

    @classmethod
    def getInitParams(cls, toPts, fromPts):
        raise NotImplementedError('implement in derived class')

    @classmethod
    def fromParams(cls, params):
        """
        Given a vector of parameters, it initializes the transform
        """ 
        raise NotImplementedError('implement in derived class')


class CameraModelTransform(Transform):
    def __init__(self, params, width, height):
        self.params = params
        self.width = width
        self.height = height
        
    @classmethod
    def fit(cls, toPts, fromPts, imageId):
        # extract width and height of image.
        params0 = cls.getInitParams(toPts, fromPts, imageId)        
        width = params0[len(params0)-2]
        height = params0[len(params0)-1]
        numPts = len(toPts.flatten())
        params0 = params0[:len(params0)-2]
        # optimize params
        params = optimize(toPts.flatten(),
                          lambda params: forwardPts(cls.fromParams(params, width, height), fromPts).flatten(),
                          params0)
        return cls.fromParams(params, width, height)

    def forward(self, pt):
        """
        Takes in a point in pixel coordinate and returns point in gmap units (meters)
        """
        lat, lon, alt, Fx, Fy = self.params
        #FOR DEBUG ONLY:
        Fx = 20000
        Fy = 20000
        
        width = self.width
        height = self.height
        
        lonLatAlt = (lon, lat, alt)  # camera position in lon,lat,alt
        opticalCenter = (int(width / 2.0), int(height / 2.0))
        focalLength = (Fx, Fy)
        # convert image pixel coordinates to ecef
        ecef = imageCoordToEcef(lonLatAlt, pt, opticalCenter, focalLength)
        # convert ecef to lon lat
        lonLatAlt = transformEcefToLonLatAlt(ecef)
        toPt = [lonLatAlt[0], lonLatAlt[1]]  # [lon, lat]
        xy_meters = lonLatToMeters(toPt) 
        return xy_meters

    def reverse(self, pt):
        """
        Takes a point in gmap meters and converts it to image coordinates
        """
        # lat, lon, alt = position of the camera
        # Fx, Fy = focal length
        lat, lon, alt, Fx, Fy = self.params
        #FOR DEBUG ONLY:
        Fx = 20000
        Fy = 20000
        width = self.width  # image width
        height = self.height  # image height
        
        #convert point to lat lon, and then to ecef
        ptlon, ptlat = metersToLatLon([pt[0], pt[1]])
        ptalt = 0
        # convert lon lat alt to ecef
        px, py, pz = transformLonLatAltToEcef([ptlon, ptlat, ptalt])
        # convert to column vector
        pt = numpy.array([[px, py, pz, 1]]).transpose()
        cameraMatrix = numpy.array([[Fx, 0, width / 2.0],  # matrix of intrinsic camera parameters
                                    [0, Fy, height / 2.0],
                                    [0, 0, 1]],
                                   dtype='float64')  
        x,y,z = transformLonLatAltToEcef((lon,lat,alt))  # camera pose in ecef
        rotation = rotMatrixFromEcefToCamera(lon, [x,y,z])  # world to camera
        cameraPoseColVector = numpy.array([[x, y, z]]).transpose()
        translation = -1* rotation * cameraPoseColVector
        # append the translation matrix (3x1) to rotation matrix (3x3) -> becomes 3x4
        rotTransMat = numpy.c_[rotation, translation]
        ptInImage = cameraMatrix * rotTransMat * pt
        u = ptInImage.item(0) / ptInImage.item(2)
        v = ptInImage.item(1) / ptInImage.item(2)
        ptInImage =  [u, v]
        return ptInImage

    @classmethod
    def getInitParams(cls, toPts, fromPts, imageId):
        mission, roll, frame = imageId.split('-')
        imageMetaData = imageInfo.getIssImageInfo(mission, roll, frame)
        try:
            """
            For now, we assume that camera frame's axis is defined as 
            z axis pointing towards Earth along the nadir vector.
            """
            issLat = imageMetaData['latitude']
            issLon = imageMetaData['longitude']
            issAlt = imageMetaData['altitude']
            foLenX = imageMetaData['focalLength'][0]
            foLenY = imageMetaData['focalLength'][1]
            # these values are not going to be optimized. But needs to be passed to fromParams 
            # to set it as member vars.
            width = imageMetaData['width']
            height = imageMetaData['height']
        except Exception as e:
            logging.error("Could not retrieve image metadata from the ISS MRF: " + str(e))
            print e 
        return [issLat, issLon, issAlt, foLenX, foLenY, width, height]

    @classmethod
    def fromParams(cls, params, width, height):
        # this makes params field passed from getInitParams accessible as a parameter of self!
        return cls(params, width, height)
    

class LinearTransform(Transform):
    def __init__(self, matrix):
        self.matrix = matrix
        self.inverse = None

    def forward(self, pt):
        u = numpy.array(list(pt) + [1], dtype='float64')
        v = self.matrix.dot(u)
        return v[:2].tolist()

    def reverse(self, pt):
        if self.inverse is None:
            self.inverse = numpy.linalg.inv(self.matrix)
        v = numpy.array(list(pt) + [1], dtype='float64')
        u = self.inverse.dot(v)
        return u[:2].tolist()

    def getJsonDict(self):
        return {'type': 'projective',
                'matrix': self.matrix.tolist()}


class TranslateTransform(LinearTransform):
    @classmethod
    def fit(cls, toPts, fromPts):
        meanDiff = (numpy.mean(toPts, axis=0) -
                    numpy.mean(fromPts, axis=0))
        tx, ty = meanDiff

        matrix = numpy.array([[1, 0, tx],
                              [0, 1, ty],
                              [0, 0, 1]],
                             dtype='float64')
        return cls(matrix)


class RotateScaleTranslateTransform(LinearTransform):
    @classmethod
    def fromParams(cls, params):
        tx, ty, scale, theta = params
        translateMatrix = numpy.array([[1, 0, tx],
                                       [0, 1, ty],
                                       [0, 0, 1]],
                                      dtype='float64')
        scaleMatrix = numpy.array([[scale, 0, 0],
                                   [0, scale, 0],
                                   [0, 0, 1]],
                                  dtype='float64')
        rotateMatrix = numpy.array([[math.cos(theta), -math.sin(theta), 0],
                                    [math.sin(theta), math.cos(theta), 0],
                                    [0, 0, 1]],
                                   dtype='float64')
        matrix = translateMatrix.dot(scaleMatrix).dot(rotateMatrix)
        return cls(matrix)

    @classmethod
    def getInitParams(cls, toPts, fromPts):
        tmat = AffineTransform.fit(toPts, fromPts).matrix
        tx = tmat[0, 2]
        ty = tmat[1, 2]
        scale = tmat[0, 0] * tmat[1, 1] - tmat[1, 0] * tmat[0, 1]
        theta = math.atan2(-tmat[0, 1], tmat[0, 0])
        return [tx, ty, scale, theta]


class AffineTransform(LinearTransform):
    @classmethod
    def fit(cls, toPts, fromPts):
        n = toPts.shape[0]
        V = numpy.zeros((2 * n, 1))
        U = numpy.zeros((2 * n, 6))
        for i in xrange(0, n):
            V[2 * i, 0] = toPts[i, 0]
            V[2 * i + 1, 0] = toPts[i, 1]
            U[2 * i, 0:3] = fromPts[i, 0], fromPts[i, 1], 1
            U[2 * i + 1, 3:6] = fromPts[i, 0], fromPts[i, 1], 1
        soln, _residues, _rank, _sngVals = numpy.linalg.lstsq(U, V)
        params = soln[:, 0]
        matrix = numpy.array([[params[0], params[1], params[2]],
                              [params[3], params[4], params[5]],
                              [0, 0, 1]],
                             dtype='float64')
        return cls(matrix)


class ProjectiveTransform(Transform):
    def __init__(self, matrix):
        self.matrix = matrix
        self.inverse = None

    def _apply(self, matrix, pt):
        u = numpy.array(list(pt) + [1], 'd')
        v0 = matrix.dot(u)
        # projective rescaling: divide by z and truncate
        v = (v0 / v0[2])[:2]
        return v.tolist()

    def forward(self, pt):
        return self._apply(self.matrix, pt)

    def reverse(self, pt):
        if self.inverse is None:
            self.inverse = getProjectiveInverse(self.matrix)
        return self._apply(self.inverse, pt)

    @classmethod
    def fromParams(cls, params):
        matrix = numpy.append(params, 1).reshape((3, 3))
        return cls(matrix)

    @classmethod
    def getInitParams(cls, toPts, fromPts):
        tmat = AffineTransform.fit(toPts, fromPts).matrix
        return tmat.flatten()[:8]
 
 
class QuadraticTransform(Transform):
    def __init__(self, matrix):
        self.matrix = matrix
 
        # there's a projective transform hiding in the quadratic
        # transform if we drop the first two columns. we use it to
        # estimate an initial value when calculating the inverse.
        self.proj = ProjectiveTransform(self.matrix[:, 2:])
 
    def _residuals(self, v, u):
        vapprox = self.forward(u)
        return (vapprox - v)
 
    def forward(self, ulist):
        u = numpy.array([ulist[0] ** 2, ulist[1] ** 2, ulist[0], ulist[1], 1])
        v0 = self.matrix.dot(u)
        v = (v0 / v0[2])[:2]
        return v.tolist()
 
    def reverse(self, vlist):
        v = numpy.array(vlist)
 
        # to get a rough initial value, apply the inverse of the simpler
        # projective transform. this will give the exact answer if the
        # quadratic terms happen to be 0.
        u0 = self.proj.reverse(vlist)
 
        # optimize to get an exact inverse.
        umin = optimize(v,
                        lambda u: numpy.array(self.forward(u)),
                        numpy.array(u0))
 
        return umin.tolist()
 
    def getJsonDict(self):
        return {'type': 'quadratic',
                'matrix': self.matrix.tolist()}
 
    @classmethod
    def fromParams(cls, params):
        matrix = numpy.zeros((3, 5))
        matrix[0, :] = params[0:5]
        matrix[1, :] = params[5:10]
        matrix[2, 2:4] = params[10:12]
        matrix[2, 4] = 1
        return cls(matrix)
 
    @classmethod
    def getInitParams(cls, toPts, fromPts):
        tmat = AffineTransform.fit(toPts, fromPts).matrix
        params = numpy.zeros(12)
        params[2:5] = tmat[0, :]
        params[7:10] = tmat[1, :]
        params[10:12] = tmat[2, 0:2]
        return params


class QuadraticTransform2(Transform):
    SCALE = 1e+7

    def __init__(self, matrix, quadraticTerms):
        self.matrix = matrix
        self.quadraticTerms = quadraticTerms
        self.projInverse = None

    def forward(self, ulist):
        u = numpy.array(list(ulist) + [1])
        v0 = self.matrix.dot(u)
        v1 = (v0 / v0[2])[:2]

        x, y = v1
        a, b, c, d = self.quadraticTerms

        p = x + a * x * x
        q = y + b * y * y
        r = p + c * q * q
        s = q + d * r * r

        # correct for pre-conditioning
        r = r * self.SCALE
        s = s * self.SCALE

        return [r, s]

    def reverse(self, vlist):
        if self.projInverse is None:
            self.projInverse = getProjectiveInverse(self.matrix)

        v = numpy.array(list(vlist) + [1])

        r, s = v[:2]

        # correct for pre-conditioning
        r = r / self.SCALE
        s = s / self.SCALE

        a, b, c, d = self.quadraticTerms

        q = s - d * r * r
        p = r - c * q * q
        x0 = solveQuad(a, p)
        if x0 is None:
            return None
        y0 = solveQuad(b, q)
        if y0 is None:
            return None

        v0 = numpy.array([x0, y0, 1])
        u0 = self.projInverse.dot(v0)
        x, y = (u0 / u0[2])[:2]

        return [x, y]

    def getJsonDict(self):
        return {'type': 'quadratic2',
                'matrix': self.matrix.tolist(),
                'quadraticTerms': list(self.quadraticTerms)}

    @classmethod
    def fromParams(cls, params):
        matrix = numpy.append(params[:8], 1).reshape((3, 3))
        quadTerms = params[8:]
        return cls(matrix, quadTerms)

    @classmethod
    def getInitParams(cls, toPts, fromPts):
        # pre-conditioning by SCALE improves numerical stability
        tmat = AffineTransform.fit(toPts / cls.SCALE,
                                   fromPts).matrix
        return numpy.append(tmat.flatten()[:8],
                            numpy.zeros(4))


def makeTransform(transformDict):
    transformType = transformDict['type']
    if transformType == 'CameraModelTransform':
        # construct a new transform from the params.
        params = transformDict['params']
        imageId = transformDict['imageId']
        mission, roll, frame = imageId.split('-')
        imageMetaData = imageInfo.getIssImageInfo(mission, roll, frame)
        return CameraModelTransform(params, imageMetaData['width'], imageMetaData['height'])
    else: 
        transformMatrix = numpy.array(transformDict['matrix'])
        if transformType == 'projective':
            return ProjectiveTransform(transformMatrix)
        elif transformType == 'quadratic':
            return QuadraticTransform(transformMatrix)
        elif transformType == 'quadratic2':
            return QuadraticTransform2(transformMatrix,
                                       transformDict['quadraticTerms'])
        else:
            raise ValueError('unknown transform type %s, expected one of: projective, quadratic'
                             % transformType)


def forwardPts(tform, fromPts):
    toPts = numpy.zeros(fromPts.shape)
    for i, pt in enumerate(fromPts):
        toPts[i, :] = tform.forward(pt)
    return toPts


def getTransformClass(n):
    if n < 2:
        raise ValueError('not enough tie points')
    elif n == 2:
        return RotateScaleTranslateTransform
    elif n == 3:
        return AffineTransform
    elif n < 7:
        return ProjectiveTransform
    else:
        return QuadraticTransform2


def getTransform(toPts, fromPts):
    n = toPts.shape[0]
    cls = getTransformClass(n)
    return cls.fit(toPts, fromPts)


def splitPoints(points):
    toPts = numpy.array([v[0:2] for v in points])
    fromPts = numpy.array([v[2:4] for v in points])
    return toPts, fromPts

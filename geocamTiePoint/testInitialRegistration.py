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

import numpy as np
from numpy import linalg as LA

import PIL.Image
try:
    from cStringIO import StringIO
except ImportError:
    from StringIO import StringIO

from geocamTiePoint import models, transform, settings
from geocamTiePoint.models import ImageData
from django.core.files.base import ContentFile

from geocamUtil.geom3 import Vector3, Point3, Ray3
from geocamUtil.sphere import Sphere
from geocamUtil.geomath import EARTH_RADIUS_METERS, transformLonLatAltToEcef, transformEcefToLonLatAlt


def degreesToRadians(degrees):
    return degrees * (np.pi / 180.)

#####################################################
#                    Classes
#####################################################

class IssImage(object):
    
    def __init__(self, filename, lonLatAlt, focalLength, sensorSize):
        self.imageName = filename
        self.imageType = 'JPEG'
        self.image = PIL.Image.open(filename).convert('RGBA') # sets alpha to 255
        self.width = self.image.size[0]
        self.height = self.image.size[1]
        self.opticalCenter = (int(self.width / 2.0) , int(self.height / 2.0))
        self.cameraLonLatAlt = lonLatAlt 
        self.focalLength = self.getAccurateFocalLengths(focalLength, sensorSize)

    def getAccurateFocalLengths(self, focalLength, sensorSize):
        """
        Parameters: image size x,y (pixels), focalLength (meters), sensorSize x,y (meters)
        
        Focal length listed on the image exif is unitless...
        We need focal length in pixels / meters. 
        Therefore, we scale the exif focal length by number of 
        pixels per meter on the actual CCD sensor.
        """
        w_s = sensorSize[0]  # in meters
        h_s = sensorSize[0]
        
        w_i = self.width  # in pixels
        h_i = self.height
        
        f = focalLength  # unit less
        
        focalLengthPixelsPerMeter = (w_i / w_s * f, h_i / h_s * f)
        return focalLengthPixelsPerMeter    


    def save(self):
        imageString = StringIO()
        self.image.save(imageString, format = self.imageType)  # saves image content in memory
        imageContent = imageString.getvalue()  # get the bits
        
        # save image contents in the 
        imageData = models.ImageData(contentType=self.imageType)
        imageData.image.save('test.jpg', ContentFile(imageContent), save=False)
        imageData.save()

#####################################################
#                 Utility Functions
#####################################################
def pixelToVector(opticalCenter, focalLength, pixelCoord):
    """
    For transforming image 2d pixel coordinates (x,y) to
    a normalized direction vector in camera coordinates.
    
    Assumptions: 
    - optical center is center of the image
    - focal length in x is equal to focal length in y
    """
    x = (pixelCoord[0] - opticalCenter[0]) / focalLength[0]
    y = (pixelCoord[1] - opticalCenter[1]) / focalLength[1]
    z = 1
    dirVec = Vector3(x,y,z)
    normDir = dirVec.norm()
    return normDir


def rotMatrixFromCameraToEcef(longitude, camPoseEcef):
    """
    Given the camera pose in ecef and camera longitude, provides rotation matrix for 
    transforming a vector from camera frame to ecef frame.
    """
    longitude = degreesToRadians(longitude)
    c1 = np.array([-1 * np.sin(longitude), np.cos(longitude), 0])
    c3 = np.array([-1 * camPoseEcef[0], -1 * camPoseEcef[1], -1 * camPoseEcef[2]])
    c3 = c3 / LA.norm(c3)  # normalize the vector
    c2 = np.cross(c3, c1)
    c2 = c2 / LA.norm(c2)  # normalize
    rotMatrix = np.matrix([c1, c2, c3])
    return np.transpose(rotMatrix)
    
    
def pointToTuple(point):
    """converts geom3 point object to a tuple"""
    pointTuple = (float(point.x), float(point.y), float(point.z)) 
    return pointTuple


# TODO: http://gis.stackexchange.com/questions/20780/point-of-intersection-for-a-ray-and-earths-surface
def imageCoordToEcef(cameraLonLatAlt, pixelCoord, opticalCenter, focalLength):
    """
    Given the camera position in ecef and image coordinates x,y
    returns the coordinates in ecef frame (x,y,z)
    """
    cameraPoseEcef = transformLonLatAltToEcef(cameraLonLatAlt)
    cameraPose = Point3(cameraPoseEcef[0], cameraPoseEcef[1], cameraPoseEcef[2])  # ray start is camera position in world coordinates
    dirVector = pixelToVector(opticalCenter, focalLength, pixelCoord)  # vector from center of projection to pixel on image.
    # rotate the direction vector (center of proj to pixel) from camera frame to ecef frame 
    rotMatrix = rotMatrixFromCameraToEcef(cameraLonLatAlt[0], cameraPoseEcef)
    dirVector_np = np.array([[dirVector.dx], [dirVector.dy], [dirVector.dz]])         
    dirVecEcef_np = rotMatrix * dirVector_np
    # normalize the direction vector
    dirVectorEcef = Vector3(dirVecEcef_np[0], dirVecEcef_np[1], dirVecEcef_np[2])
    dirVectorEcef = dirVectorEcef.norm()
    #construct the ray
    ray = Ray3(cameraPose, dirVectorEcef)
    #intersect it with Earth
    earthCenter = Point3(0,0,0)  # since we use ecef, earth center is 0 0 0
    earth = Sphere(earthCenter, EARTH_RADIUS_METERS)
    t = earth.intersect(ray)
    
    if t != None:
        # convert t to ecef coords
        ecefCoords = ray.start + t*ray.dir
        return pointToTuple(ecefCoords)
    else: 
        return None


def getCenterPointCoordinates(image):
    imageCoords = [image.width / 2.0, image.height / 2.0]
    return imageCoordToEcef(image.cameraLonLatAlt, imageCoords, image.opticalCenter, image.focalLength)
    

def getBboxFromImageCorners(image):
    """
    Calculate 3d world position of four image corners
    given image and camera params.
    """
    corner1 = [0,0]
    corner2 = [image.width, 0]
    corner3 = [0, image.height]
    corner4 = [image.width, image.height]

    # this returns None when there is no intersection...
    corner1_ecef = imageCoordToEcef(image.cameraLonLatAlt, corner1, image.opticalCenter, image.focalLength)
    corner2_ecef = imageCoordToEcef(image.cameraLonLatAlt, corner2, image.opticalCenter, image.focalLength)
    corner3_ecef = imageCoordToEcef(image.cameraLonLatAlt, corner3, image.opticalCenter, image.focalLength)
    corner4_ecef = imageCoordToEcef(image.cameraLonLatAlt, corner4, image.opticalCenter, image.focalLength)
    print corner1_ecef
    print corner2_ecef
    print corner3_ecef
    print corner4_ecef
    return [corner1_ecef, corner2_ecef, corner3_ecef, corner4_ecef]
        
"""
These are needed when there is meta data and we are generating 

"""
# def cameraToImageCoord(x, y, z):
#     pass
# 
# def ecefToCameraCoord(xe, ye, ze):
#     pass 
# 
# def lonLatAltToImageCoord(lonLatAlt):
#     pass        
# 
# def getColorValues(imageCorners):
#     """
#     Given image corners in long,lat coordinates
#     iterate over them and find corresponding rgb values from the
#     iss Image. 
#     """
#     pass

        
#####################################################
#                    Main
#####################################################

def main():    
    imageName = settings.DATA_DIR + "geocamTiePoint/overlay_images/ISS_Small.JPG"    
    issLongitude = -87.4
    issLatitude = 29.3
    issAltitude = 409000
    longLatAlt = (issLongitude, issLatitude, issAltitude)
    focalLength = 0.4
    sensorSize = (.036,.0239)
    
    issImage = IssImage(imageName, longLatAlt, focalLength, sensorSize)
    corners = getBboxFromImageCorners(issImage)
    centerPoint = getCenterPointCoordinates(issImage)
    print "centerpoint" + str(transformEcefToLonLatAlt(centerPoint))
    
    # Sanity check
#     print "Corner0 " + str(transformEcefToLonLatAlt(corners[0])) + " should equal to 29degrees 45'23.36 N, 89degrees56'52.85W "
#     print "Corner1 " + str(transformEcefToLonLatAlt(corners[1])) + " should equal to 29 50 29 82N , 90 21 55 40W "
#     print "Corner2 " + str(transformEcefToLonLatAlt(corners[2])) + " should equal to 30degrees 01'03.43N, 89 51 44 15W  "
#     print "Corner3 " + str(transformEcefToLonLatAlt(corners[3])) + " should equal to 30 06 31 28N, 90 17 04 01 W"
     
main()
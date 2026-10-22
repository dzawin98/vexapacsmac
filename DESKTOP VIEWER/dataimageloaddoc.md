ImageId
A Cornerstone3D ImageId is a URL which identifies a single image for cornerstone to display.

The URL scheme in the ImageId is used by Cornerstone to determine which Image Loader plugin to call to actually load the image. It should be noted that Cornerstone3D delegates loading of the images to the registered image loaders. This strategy allows Cornerstone to simultaneously display multiple images obtained with different protocols from different servers. For example, Cornerstone could display a DICOM CT image obtained via WADO alongside a JPEG dermatology image captured by a digital camera and stored on a file system.

The ImageId format

image-id-format

DICOM Persistent Objects (WADO) is a standard for storing and retrieving medical images using the DICOM protocol. WADO allows for retrieval (and storage) of images from a WADO-compliant server. Here are some examples of what an imageId would look like for different ImageLoader plugins:

WADO-URI

http://www.medical-webservice.st/RetrieveDocument?
requestType=WADO&studyUID=1.2.250.1.59.40211.12345678.678910
&seriesUID=1.2.250.1.59.40211.789001276.14556172.67789
&objectUID=1.2.250.1.59.40211.2678810.87991027.899772.2
&contentType=application%2Fdicom&transferSyntax=1.2.840.10008.1.2.4.50



WADO-RS

https://d14fa38qiwhyfd.cloudfront.net/dicomweb/
studies/1.3.6.1.4.1.25403.345050719074.3824.20170126083429.2/
series/1.3.6.1.4.1.25403.345050719074.3824.20170126083454.5/
instances/1.3.6.1.4.1.25403.345050719074.3824.20170126083455.3/frames/1


Cornerstone does not specify what the contents of the URL are - it is up to the Image Loader to define the contents and format of the URL so that it can locate the image. For example, a proprietary Image Loader plugin could be written to talk to a proprietary server and lookup images using a GUID, filename or database row id.

Here are some examples of what an ImageId could look like for different Image Loader plugins:

example://1
dicomweb://server/wado/{uid}/{uid}/{uid}
http://server/image.jpeg
custom://server/uuid
wadors://server/{StudyInstanceUID}/{SeriesInstanceUID}/{SOPInstanceUID}


Image Loaders
An ImageLoader is a JavaScript function that is responsible for taking an ImageId and returning an Image Object. Since loading images usually requires a call to a server, the API for image loading needs to be asynchronous. Cornerstone requires that Image Loaders return an Object containing a Promise which Cornerstone will use to receive the Image Object asynchronously, or an Error if one has occurred.

Image Loader Workflow
ImageLoaders register themselves using registerImageLoader API with cornerstone to load specific ImageId URL schemes
The application requests to load an image using the loadImage API for stack or createAndCacheVolume API for volume.
Cornerstone delegates the request to load the image to the ImageLoader registered with the URL scheme of the imageId.
The ImageLoader will return an Image Load Object containing a Promise which it will resolve with the corresponding Image Object once it has obtained the pixel data. Obtaining the pixel data may require a call to a remote server using XMLHttpRequest, decompression of the pixel data (e.g. from JPEG 2000), and conversion of the pixel data into the format that Cornerstone understands (e.g. RGB vs YBR color).
The Image Object passed back by the resolved Promise is then displayed using renderingEngine API.
Register Image Loader
You can use registerImageLoader to make an external image loader available to the cornerstone library. This function accept a scheme which the image loader function (second argument) should act on.

Available Image Loaders
Image Loader	Used for
Cornerstone DICOM Image Loader	DICOM Part 10 images; Supports WADO-URI and WADO-RS; Supports multi-frame DICOM instances; Supports reading DICOM files from the File objects
Cornerstone Web Image Loader	PNG and JPEG
Cornerstone-nifti-image-loader	NIFTI
CornerstoneDICOMImageLoader
CornerstoneDICOMImageLoader is a cornerstone image loader that loads DICOM images from a WADO-compliant server. You can install it and initialize to via the following code. Internally, CornerstoneDICOMImageLoader registers its wado-rs and wado-uri imageLoaders to Cornerstone3D and uses dicomParser to parse the the metadata and pixel data.

import { init } from '@cornerstonejs/dicom-image-loader';

init({
  maxWebWorkers: navigator.hardwareConcurrency || 1,
});


After initialization of the CornerstoneDICOMImageLoader, any imageId using the wado-uri scheme will be loaded using the CornerstoneDICOMImageLoader wado-uri image loader and metadata provider (e.g., imageId = 'wado-uri: https://exampleServer.com/wadoURIEndPoint?requestType=WADO&studyUID=1.2.3&seriesUID=4.5.6&objectUID=7.8.9&contentType=application%2Fdicom'), and likewise for wado-rs imageIds which will use CornerstoneDICOMImageLoader wado-rs image loader and metadata provider (e.g., imageId = 'wado-rs: https://exampleServer.com/wadoRSEndPoint/studies/1.2.3/series/4.5.6/instances/7.8.9/frames/1').

CornerstoneWebImageLoader
You can take a look at our sample code example for CornerstoneWebImageLoader here

Image Object
Cornerstone Image Loaders return Image Load Objects which contain a Promise. The reason we have chosen to use an Object instead of solely returning a Promise is because now Image Loaders can also return other properties in their Image Load Objects. As an example, we intend to implement support for cancelling pending or ongoing requests using a cancelFn passed back by an Image Loader within an Image Load Object.

Here is an interface of such Image Load Object. You can read more about each field in the IImage section of API reference.

interface IImage {
  imageId: string
  sharedCacheKey?: string
  minPixelValue: number
  maxPixelValue: number
  slope: number
  intercept: number
  windowCenter: number[]
  windowWidth: number[]
  getPixelData: () => Array<number>
  getCanvas: () => HTMLCanvasElement
  rows: number
  columns: number
  height: number
  width: number
  color: boolean
  rgba: boolean
  numberOfComponents: number
  columnPixelSpacing: number
  rowPixelSpacing: number
  sliceThickness?: number
  invert: boolean
  sizeInBytes: number
  scaling?: {
    PET?: {
      SUVlbmFactor?: number
      SUVbsaFactor?: number
      suvbwToSuvlbm?: number
      suvbwToSuvbsa?: number
    }
  }
}


Metadata Providers
For package-level architecture and current 5.x metadata behavior, see Metadata Module.

Medical images typically come with lots of non-pixel-wise metadata such as the pixel spacing of the image, the patient ID, or the scan acquisition date. With some file types (e.g. DICOM), this information is stored within the file header and can be read and parsed and passed around your application. With others (e.g. JPEG, PNG), this information needs to be provided independently from the actual pixel data. Even for DICOM images, however, it is common for application developers to provide metadata independently from the transmission of pixel data from the server to the client since this can considerably improve performance.

A Metadata Provider is a JavaScript function that acts as an interface for accessing metadata related to Images in Cornerstone. Users can define their own provider functions in order to return any metadata they wish for each specific image. A Metadata Provider function has the following prototype:

function metadataProvider(type: string, ...queries: any): any


However, typically, providers implement the following, more simple prototype:

function metadataProvider(type: string, imageId: string): Record<string, any>


This is because most metadata is provided for ImageIds, but Cornerstone provides infrastructure for the definition and usage of metadata providers for any information.

Types of Metadata
The type parameter to a metadata provider can be any string. You can call cornerstone.metaData.get() with any type, and if any metadata provider can provide that type for the given image ID, you get the response. You can use this, for example, to easily provide application-specific information such as ground truth or patient information.

Cornerstone core and tools also automatically request various types of metadata for displayed images. A list of standard metadata modules can be found in the MetadataModules section of the API reference. Many of these modules conform to the DICOM standard. If you want to implement them in a custom metadata provider, it is easiest to look at how an existing metadata provider implements them, such as the WADOURI metadata provider.

Priority of Metadata Providers
Since it is possible to register more than one metadata provider, upon adding a provider you can define a priority number for it. When there is a time to request metadata, Cornerstone requests the metadata for imageId by the priority order of providers (if provider returns undefined for the imageId, Cornerstone moves to the next provider).

For instance, if provider1 is registered with 10 priority and provider2 is registered with 100 priority, provider2 is asked first for the metadata for the imageId.

Provided Computed Metadata
There are a few metadata providers which either store metadata information updated/modified while running, or which transform the existing metadata into other formats, or provide static metadata.

Transient Metadata
Calibrated Pixel Spacing
The calibratedPixelSpacingMetadataProvider allows storing of over-ride values for the calibration metadata, allowing a user or system to add calibration of spacing for an image independent of the original metadata.

Computed Metadata
Some metadata can be computed based on other metadata available in the system. For example, the adapters module can generate study module information in the 'Normalized' format from dcmjs based on the existing default metadata providers.

It is suggested that any metadata that is computed just from straight DICOM data, but is modified in some way use a computed metadata provider. This pattern allows creating standard computed changes to the existing metadata across a variety of different types of underlying data such as multiframe instances, formatted data, or data used for producing new instances

referencedMetadataProvider
The adapters module provides referenced metadata useful when creating new instances based on an existing module. It also provides constants for the Part 10 prefix header and referenced objects.

Study, Series, Instance Data
The data modules provide the study or series level information in the 'Normal' format for dcmjs, without including the full instance header, and based on the underlying standard modules defined for WADO-URI, RS and from OHIF.

Part 10 Constants
The part 10 _meta field in dcmjs can be hard coded, but that prevents changes to the generated object without modifying the object after creation or without modifying the creation code. The part 10 constants metadata provides the standard 0002 header module for dcmjs to use when encoding DICOM.

Referenced and Predecessor Data
The referenced data and predecessor sequence providers allow replacing the default instance in an SR or SEQ type series with a new one that references the previously used data.

metaData helpers
The metaData service has a few helper methods to deal with naming variations and computed results.

getNormalized
The get normalized module method will take a set of modules in the lower camel case version, and combine them into an upper (dcmjs NormalCase) version. This is used for creating an instance module from non-dcmjs data sources as well as for creating the study/series/instance data modules.

capitalizeTag and lowerTag
There are some specific rules needed for converting between UpperCamelCase names used in dcmjs normalized modules and the lowerCamelCase names used in the metaData modules. These are encapsulated into helper functions available on the metaData object exported from CS3D core.
Volumes
A volume is a 3D data array that has a physical size and orientation in space. It can be built by composing pixel data and metadata of a 3D imaging series, or can be defined from scratch by the application. A volume has a FrameOfReferenceUID, voxelSpacing (x,y,z), voxel dimensions (x,y,z), origin, and orientation vectors which uniquely define its coordinate system with respect to the patient coordinate system.

ImageVolume
In Cornerstone3D we use the ImageVolume base class to represent a 3D image volume. All volumes are derived from this class. For instance the StreamingImageVolume which is used to represent a volume that is being streamed image by image. We will discuss the StreamingImageVolume class in more detail later.

interface IImageVolume {
  /** unique identifier of the volume in the cache */
  readonly volumeId: string
  /** volume dimensions */
  dimensions: Point3
  /** volume direction */
  direction: Float32Array
  /** volume metadata */
  metadata: Metadata
  /** volume origin - set to the imagePositionPatient of the last image in the volume */
  origin: Point3
  /** volume scaling metadata */
  scaling?: {
    PET?: {
      SUVlbmFactor?: number
      SUVbsaFactor?: number
      suvbwToSuvlbm?: number
      suvbwToSuvbsa?: number
    }
  }
  /** volume size in bytes */
  sizeInBytes?: number
  /** volume spacing */
  spacing: Point3
  /** number of voxels in the volume */
  numVoxels: number
  /** volume image data as vtkImageData */
  imageData?: vtkImageData
  /** openGL texture for the volume */
  vtkOpenGLTexture: any
  /** loading status object for the volume containing loaded/loading statuses */
  loadStatus?: Record<string, any>
  /** imageIds of the volume (if it is built of separate imageIds) */
  imageIds?: Array<string>
  /** volume referencedVolumeId (if it is derived from another volume) */
  referencedVolumeId?: string // if volume is derived from another volume
  /** voxel manager */
  voxelManager?: IVoxelManager
}


Voxel Manager
The VoxelManager is responsible for managing the voxel data of a volume. In previous version of Cornerstone3D we used to include scalarData in the ImageVolume object. However, this approach had several limitations in memory usage and performance. Therefore, we now delegate the voxel data management to the VoxelManager class which is a stateful class that keeps track of the voxel data in a volume.

You can read more about the VoxelManager class here.

VoxelManager Documentation
The VoxelManager is a key component of the Cornerstone library’s new architecture for handling voxel data and volume management. This updated design streamlines data flow and enhances performance, providing a single source of truth for image caching and data access, with a focus on reducing memory usage and improving performance in handling large image datasets.

Overview
With the integration of VoxelManager, voxel data handling shifts from relying on large scalar arrays to using individual images and targeted voxel data access methods. VoxelManager serves as an adapter for tools and functions that interact with voxel data, providing efficient methods for accessing, modifying, and streaming voxel information.

Key Features
Single Source of Truth: Only the image cache is used, eliminating the need for separate volume caches and reducing synchronization issues.
Efficient Volume Streaming: Loads image by image, caching only what’s necessary and streaming data directly to the GPU.
Optimized Caching: Data is stored in its native format and converted only as needed, minimizing memory and processing overhead.
Simplified Web Worker Implementation: Removed SharedArrayBuffer dependencies, simplifying security and worker requirements.
VoxelManager API
The VoxelManager API replaces direct scalar data access with methods that provide precise control over voxel data without generating large data arrays. Here are the primary methods and usage patterns:

Accessing Voxel Data
getScalarData(): Returns the scalar data array for individual images (applicable only to IImage).
getScalarDataLength(): Provides the total voxel count, replacing scalarData.length.
getAtIndex(index): Retrieves the voxel value at a specific linear index.
setAtIndex(index, value): Sets the voxel value at a specific linear index.
getAtIJK(i, j, k): Gets the voxel value at IJK coordinates.
setAtIJK(i, j, k, value): Sets the voxel value at IJK coordinates.
getArrayOfModifiedSlices(): Lists modified slice indices.
Data Manipulation
forEach(callback, options): Iterates over voxels with a callback for processing or modifying data.
toIndex(ijk): Converts IJK coordinates to a linear index.
toIJK(index): Converts a linear index back to IJK coordinates.
Volume Information
getConstructor(): Returns the scalar data type constructor.
getBoundsIJK(): Fetches the volume bounds in IJK coordinates.
Specialized Methods
setTimePoint(timePoint): For 4D datasets, sets the current time point.
getAtIndexAndTimePoint(index, timePoint): Retrieves the voxel value at a specified index and time point.
Example: Migrating Data Access and Manipulation
Instead of accessing scalarData directly, use VoxelManager for data manipulation. Here’s a migration example:

Before
function processVolume(volume) {
  const scalarData = volume.getScalarData();
  for (let i = 0; i < scalarData.length; i++) {
    if (scalarData[i] > 100) {
      scalarData[i] = 100;
    }
  }
}

After
function processVolume(volume) {
  const voxelManager = volume.voxelManager;
  const length = voxelManager.getScalarDataLength();
  for (let i = 0; i < length; i++) {
    const value = voxelManager.getAtIndex(i);
    if (value > 100) {
      voxelManager.setAtIndex(i, 100);
    }
  }
}

Handling Image Volume Construction
When creating volumes, scalarData is no longer required. Instead, use VoxelManager internally:

Before
const streamingImageVolume = new StreamingImageVolume({
  volumeId,
  metadata,
  dimensions,
  spacing,
  origin,
  direction,
  scalarData,
  sizeInBytes,
  imageIds,
});

After
const streamingImageVolume = new StreamingImageVolume({
  volumeId,
  metadata,
  dimensions,
  spacing,
  origin,
  direction,
  imageIds,
  dataType,
  numberOfComponents,
});

Best Practices
Data Access Optimization: Use getAtIndex and setAtIndex for bulk operations due to their efficiency. Use forEach for large-volume iteration.
Memory Management: Avoid getCompleteScalarDataArray() as it rebuilds large data arrays and can degrade performance.
Handling RGB Data: getAtIndex and getAtIJK return [r, g, b] arrays for RGB volumes.
Conclusion
The VoxelManager is central to Cornerstone’s new volume management strategy, offering a flexible, efficient API for voxel data access and manipulation. This migration to VoxelManager allows for more efficient memory usage, faster performance, and improved compatibility with large datasets, ensuring a smoother workflow for developers working with complex medical imaging data.

olume Loaders
Similar to the Image Loaders, a volume loader takes a volumeId and other information that is required to load a volume and returns a Promise that resolves into a Volume. This Volume can be a constructed from a set of 2D images (e.g., imageIds) or can be from one 3D array object (such as NIFTI format).

We have added cornerstoneStreamingImageVolumeLoader library to support streaming of the 2D images (imageIds) into a 3D volume and it is the default volume loader for streaming volumes.

Register Volume Loaders
You can use registerVolumeLoader to define a volume loader which should be called on a particular scheme. Below you can see a simplified code for our cornerstoneStreamingImageVolumeLoader in which:

Based on a set of imageIds, we compute volume metadata such as: spacing, origin, direction, etc.

Instantiate a new StreamingImageVolume

StreamingImageVolume implements methods for loading (.load)
It implements load via using imageLoadPoolManager
Each loaded frame (imageId) is put at the correct slice in the 3D volume
Return a Volume Load Object which has a promise that resolves to the Volume.

function cornerstoneStreamingImageVolumeLoader(
  volumeId: string,
  options: {
    imageIds: Array<string>,
  }
) {
  // Compute Volume metadata based on imageIds
  const volumeMetadata = makeVolumeMetadata(imageIds);
  const streamingImageVolume = new StreamingImageVolume(
    // ImageVolume properties
    {
      volumeId,
      metadata: volumeMetadata,
      dimensions,
      spacing,
      origin,
      direction,
      scalarData,
      sizeInBytes,
    },
    // Streaming properties
    {
      imageIds: sortedImageIds,
      loadStatus: {
        loaded: false,
        loading: false,
        cachedFrames: [],
        callbacks: [],
      },
    }
  );

  return {
    promise: Promise.resolve(streamingImageVolume),
    cancel: () => {
      streamingImageVolume.cancelLoading();
    },
  };
}

registerVolumeLoader(
  'cornerstoneStreamingImageVolume',
  cornerstoneStreamingImageVolumeLoader
);

// Used for any volume that its scheme is not provided
registerUnknownVolumeLoader(cornerstoneStreamingImageVolumeLoader);


As seen above, since the cornerstoneStreamingImageVolumeLoader is registered with the scheme cornerstoneStreamingImageVolume, we can load a volume with the scheme cornerstoneStreamingImageVolume by passing the volumeId as shown below:

const volumeId = 'cornerstoneStreamingImageVolume:myVolumeId';

const volume = await volumeLoader.createAndCacheVolume(volumeId, {
  imageIds: imageIds,
});


Default unknown volume loader
By default if no volumeLoader is found for the scheme, the unknownVolumeLoader is used. cornerstoneStreamingImageVolumeLoader is the default unknown volume loader.

info
Even if you don't provide the scheme, the cornerstoneStreamingImageVolumeLoader will be used by default.

So the following code will work as well:

const volumeId = 'myVolumeId';
const volume = await volumeLoader.createAndCacheVolume(volumeId, {
  imageIds: imageIds,
});

Geometry Loaders
This section describes the geometry loaders in Cornerstone Core.

If you read the Segmentation rendering section you can see that a Segmentation can be rendered as a Volume (Labelmap), or it can be rendered as a Contour, or Surface.

TIP
Similar relationship structure has been adapted in popular medical imaging software such as 3D Slicer with the addition of polymorph segmentation.

Geometry loaders are used to load and cache geometry data from a file or URL in general.

Register Mesh Loader
You can use registerGeometryLoader to make an external mesh loader available to the cornerstone library. This function accept a scheme which the mesh loader function (second argument) should act on.

import {
  geometryLoader,
  cornerstoneMeshLoader,
  Enums,
  Types,
} from '@cornerstonejs/core';

geometryLoader.registerGeometryLoader('mesh', cornerstoneMeshLoader);


CornerstoneMeshLoader
You can take a look at our sample code example for cornerstoneMeshLoader here

const mesh1 = await geometryLoader.loadAndCacheGeometry(
  'mesh:https://example.com/mesh.ply',
  {
    type: Enums.GeometryType.MESH,
    geometryData: {
      id: 'mesh1',
      format: Enums.MeshType.PLY,
    } as Types.MeshData,
  }
);

const mesh2 = await geometryLoader.loadAndCacheGeometry(
  'mesh:https://example.com/mesh.obj',
  {
    type: Enums.GeometryType.MESH,
    geometryData: {
      id: 'mesh2',
      format: Enums.MeshType.OBJ,
      materialUrl: 'https://example.com/material.mtl',
    } as Types.MeshData,
  }
);

viewport.setActors([
  { uid: mesh1.id, actor: (mesh1.data as Types.IMesh).actor },
  { uid: mesh2.id, actor: (mesh2.data as Types.IMesh).actor },
]);


Supported mesh formats
The supported mesh formats for the cornerstoneMeshLoader are:

PLY
OBJ
STL
VTP
Supported material formats
The supported material formats for the cornerstoneMeshLoader are:

MTL
JPG
PNG
JPEGCache
The Cache API’s role is to keep track of created volumes, manage memory usage, and alert the host application when trying to allocate data that would exceed application defined limits.

This module deals with Caching of images and volumes

The cache has two main components: a volatile portion for images and a non-volatile portion for volumes. We will have a shared block of memory allocated for the entire cache, e.g. 1GB which will be shared for images and volumes.

Individual 2D images are volatile and will be replaced by new images hitting the cache.
When you allocate volumes, it tags the images used by the volume as non-volatile unless you release the volume.
Utilities for the cache
There are various utility functions you can use to manage the cache.

isCacheable: One of the many utility functions that the Cache API provides is isCacheable which you can use to check if there is enough free space before initiating the fetch for the volume or image.
purgeCache: Deletes all the images and volumes inside the cache.
decacheIfNecessaryUntilBytesAvailable: It purges the cache if necessary based on the requested number of bytes.
Cache Optimizations
All data in the cache is actually image objects. When you request a volume, we pass the images necessary for the volume to the GPU on demand, and at no point do we store the voxel data of the volume in the cache. If you need to access the voxel data of a volume, you can do so by using the VoxelManager class.

If you ever actually need the full voxel data of a volume, you can use the VoxelManager class method .getCompleteScalarDataArray() to get the full voxel data.

This new change that was introduced in Cornerstone3D 2.x is part of the new image-based approach that aims to improve performance, reduce memory usage, and provide more efficient data access, especially for large datasets.

Here are other benefits of the new approach:

Single Source of Truth

Previously: Data existed in both image cache and volume cache, leading to synchronization issues.
Now: Only one source of truth - the image cache.
Benefits: Improved syncing between stack and volume segmentations.
New Volume Creation Approach

Everything now loads as images.
Volume streaming is performed image by image.
Only images are cached in the image cache.
For volume rendering, data goes directly from image cache to GPU, bypassing CPU scalar data.
Benefits: Eliminated need for scalar data in CPU, reduced memory usage, improved performance.
VoxelManager for Tools

Acts as an intermediary between indexes and scalar data.
Provides mappers from IJK to indexes.
Retrieves information without creating scalar data.
Processes each image individually.
Benefits: Efficient handling of tools requiring pixel data in CPU.
Handling Non-Image Volumes

Volumes without images (e.g., NIFTI) are chopped and converted to stack format.
Makes non-image volumes compatible with the new image-based approach.
Optimized Caching Mechanism

Data stored in native format instead of always caching as float32.
On-the-fly conversion to required format when updating GPU textures.
Benefits: Reduced memory usage, eliminated unnecessary data type conversions.
Elimination of SharedArrayBuffer

Removed dependency on SharedArrayBuffer.
Each decoded image goes directly to the GPU 3D texture at the correct size and position.
Benefits: Reduced security constraints, simplified web worker implementation.Viewports
A viewport can be thought of as:

A camera viewing an image from a specific perspective.
A canvas to display the output of this camera.
A set of transforms from the image data to viewable data (LUT, Window Level, Pan etc)
In Cornerstone3D viewports are created from HTML elements, and the consumer should pass the element for which the viewport should be created. For example, a CT series can be viewed via 4 viewports in a “4-up” view: Axial MPR, Sagittal MPR, Coronal MPR, A 3D perspective volume render.

See Viewport Reference and Presentation for more details on the reference and presentation details that select which image and how that image is presented.

Generic/Next viewport implementations use semantic ViewState as their mutation source of truth. Code that needs cross-viewport pan, zoom, rotation, scale, or renderer-camera output should use Viewport Projection instead of copying camera objects between viewport families.



StackViewport
Suitable for rendering a stack of images, that might or might not belong to the same image.
Stack can include 2D images of various shapes, size and direction
VolumeViewport
Suitable for rendering a volumetric data which is considered as one 3D image.
Having a VolumeViewport enables Multi-planar reformation or reconstruction (MPR) by design, in which you can visualize the volume from various different orientations without addition of performance costs.
For having image fusion between two series
3D Viewport
Sutiable for actual 3D rendering of a volumetric data.
For having different types of presets such as Bone, Soft Tissue, Lung, etc.
note
Both StackViewport and VolumeViewport, VolumeViewport3D are created via the RenderingEngine API.

VideoViewport
Suitable for rendering video data
Video can include MPEG 4 encoded vide streams. In theory, MPEG2 is also supported, but practically the browser doesn't support that.
Whole Slide Image Viewport
Suitable for rendering whole slide images
Initial Display Area
All viewports inherit from the Viewport class which has a displayArea field which can be provided. This field can be used to programmatically set the initial zoom/pan on an image. By default, the viewport will fit the dicom image to the screen. The displayArea takes a DisplayArea type which has the following fields.

type DisplayArea = {
  imageArea: [number, number], // areaX, areaY
  imageCanvasPoint: {
    imagePoint: [number, number], // imageX, imageY
    canvasPoint: [number, number], // canvasX, canvasY
  },
  storeAsInitialCamera: boolean,
};

Zoom and pan are all relative to the initial "fit to screen" view.

In order to zoom into the image 200%, we would set the imageArea to [0.5, 0.5].

Panning is controlled by a provided imagePoint and a provided canvasPoint. You can imagine the canvas as a sheet of white paper and the image as another sheet of paper like a chest x-ray. Mark a point in the canvas paper with a pen and then mark another point on your chest x-ray image. Now try to "pan" your image so the point so the imagePoint matches the canvasPoint. This is what the API design of imageCanvasPoint represents.

Thus if you wanted to left align you image, you could provide the following value:

imageCanvasPoint: {
  imagePoint: [0, 0.5], // imageX, imageY
  canvasPoint: [0, 0.5], // canvasX, canvasY
};

This means the left (0) middle (0.5) point on the canvas needs to align with the left (0) middle (0.5) point on the image. Values are based on % size of the full image. In this example, if we had a 1024 x 1024 x-ray image. The imagePoint would be [0, 512]. Let's say we were on a mobile iPhone in landscape mode (844 x 390). The canvasPoint would be [0, 195].
Server Requirements
Fast initial display of images requires a method to retrieve just a portion of an image or volume that can be rendered as a complete but lossy image. For instance, an image could be rendered using partial data (resolution), or images in a volume could be interpolated to generate an alternative image. These images are initially retrieved for rapid display, followed by retrieving a full-resolution image, resulting in a progressively improved display as more data is loaded.

The DICOM Standards Committee just added support in DICOM for a new encoding method called High Throughput JPEG 2000 (HTJ2K). This encoding method enables progressive decoding of images, meaning that if the first N bytes of the image encoding are available, they can be decoded into a lower resolution or lossy image. The configuration that enables this feature is called HTJ2K Progressive Resolution (HTJ2K RPCL) or High Throughput JPEG 2000 Resolution Position Component Layer.

Finally, some servers can be configured to serve up reduced (partial) resolution versions of images on other URL endpoints.

The progressive loading will improve the display of stacked images by supporting HTJ2K progressive resolution encoded data. Meanwhile, volumetric data will be enhanced in terms of the time it takes to load the first volume for all backends, unless they are specifically configured for custom load order. However, the support for different types of reduced resolution and streaming responses varies significantly among DICOMweb implementations. Therefore, this guide provides additional details on how to configure various configurations.

Server Requirements
As HTJ2K is a new encoding (and still not merged into the DICOM standard, although approved for merging), it is not yet widely supported by DICOMweb servers. The various ways that servers support it might change in the future. However, we envision two main ways that this will be implemented in most servers but both require the server to support the DICOMWeb standard and HTJ2K RPCL encoding.

HTJ2K Support: For HTJ2K encoded images, the server must support the streaming of image data in a way that respects the HTJ2K RPCL configuration, allowing the client to decode partial data into a displayable image.
Respond with Streaming Data
XHR (XMLHttpRequest) streaming is an extension of the XHR browser-level API that enables the client to retrieve pieces of data as it arrives, instead of waiting for the entire response. XHR streaming works by keeping a persistent connection between the client and server and sending data incrementally as it becomes available.

Respond with Byte Range Request
An XHR byte range request is a feature of the XMLHttpRequest object in JavaScript that allows for retrieving only a specific range of bytes from a server. This feature is typically used for downloading large files in chunks or resuming interrupted downloads. By specifying the starting and ending byte positions, the server can send only the requested portion of the file, reducing bandwidth usage and improving download efficiency.

Partial Content Delivery: The server must support HTTP Range requests, allowing the client to request and receive specific byte ranges of the image data. This is crucial for handling large images or volumes by fetching and rendering portions of the data progressively.
info
The existing JPEG 2000 encoding and the new [HTJ2K in the standard](https://dicom.nema.org/medical/dicom/Supps/LB/sup235_lb_HTJ2K.pdf) also have a format that specifies a partial resolution endpoint. The exact endpoint needs to be specified in the JPIP referenced data URL. The options data could be used to provide the exact URL required in a future revision.

Encoding
Types of Partial Resolution
There are a few types of partial resolution image:

lossy images are original resolution/bit depth, but lossy encoded
thumbnail images are reduced resolution images
byte range images are a prefix of the full resolution, followed by retrieving the remaining data. This only works for images like HTJ2K encoded in resolution first ordering.
Creating Partial Resolution Images
Static DICOMweb repository has been enhanced to add the ability to create partial resolution images, as well as to serve up byte range requests. Some example commands for a Ct dataset are below:

# Create HTJ2K as default and write HTJ2K lossy to .../lossy/
mkdicomweb create -t jhc --recompress true --alternate jhc --alternate-name lossy d:\src\viewer-testdata\dcm\Juno
# Create JLS and JLS thumbnail versions
mkdicomweb create -t jhc --recompress true --alternate jls --alternate-name jls /src/viewer-testdata/dcm/Juno
mkdicomweb create -t jhc --recompress true --alternate jls --alternate-name jlsThumbnail --alternate-thumbnail /src/viewer-testdata/dcm/Juno
# Create HTJ2K lossless and thumbnail versions (this is not required in general
# when the top item is already lossless)
mkdicomweb create -t jhc --recompress true --alternate jhcLossless --alternate-name htj2k  /src/viewer-testdata/dcm/Juno
mkdicomweb create -t jhc --recompress true --alternate jhc --alternate-name htj2kThumbnail --alternate-thumbnail /src/viewer-testdata/dcm/Juno


Any other tools creating multipart/related encapsulated data can be used, as can using accept headers or parameters for a standard DICOMweb server.

Note the data path for these is, in general the normal DICOMweb path with /frames/ replaced by some other name.

Retrieve Configuration
Progressive loading works in steps called stages. Each stage is part of which images load with which settings, and you can set each stage with different settings, known as retrieve options. Together (stages and options) make up the retrieve configuration, which manages how images are loaded step by step. Let's dive in.

interface IRetrieveConfiguration {
  stages: RetrieveStage[];
  retrieveOptions: Record<string, RetrieveOptions>;
}

Retrieve Stages
As the name of progressive loading suggests, the loading process is done in stages. Each stage can be configured to use a different retrieve method (streaming or byteRange) and its common or specific retrieve options.

info
Since you can have multiple stages, the two methods (streaming and byte range) can be combined and utilized at different stages.

For instance you can create a configuration that

start streaming of specific initial slices (typically the first, middle, or last slice) for immediate viewing.
Subsequently, in the second stage, byte range requests (only couple of kb) can be made for the rest of the slices to efficiently render the complete volume as quickly as possible (even if lossy).
Finally, you perform supplementary byte range requests for the remaining segments that have not yet been requested, following the initial byte range request in step 2.
This approach is actually employed in the volume loading process, which will be further elaborated upon in our subsequent discussion.

So, in summary, the Retrieve Stage is a configuration that specifies which images load with which settings. For the simplicity of this document and to not lose focus, we will only talk about the retrieveType, which is just a reference to the retrieve options. We will discuss more advanced options, such as selecting images for strategy, prioritizing, and queuing loading, later.



As seen above, the retrieve stages can be as simple a list of objects, each with an id and a retrieveType (which is a reference to the retrieve options which we will talk next).

tip
The retrieveType is an optional string that is only used for referencing the option to be used. You can use any string as long as you are consistent in using it in the retrieve options as well. Use 'lkajsdflkjaslfkjsadlkfj' if you wish (but then you should have an object with key of 'lkajsdflkjaslfkjsadlkfj' in the retrieveOptions object as we will see below).

What would happen if we reference a retrieve type that is not defined in the retrieve options?

Retrieve Options
Now we an talk about retrieve options for each of the methods (streaming or byte range) in more detail. Let's dive into the common options first.

Common Options
There are more advanced options for the retrieval configuration that can be used to handle more use cases. We will talk about them later in another section.

Decode Level (quality)
One natural question that might arise is, regardless of the method (stream or byte range) how often the image is decoded and when we decode what is the resolution of the image that we should decode to?

The resolution of decoding is controlled by decodeLevel configuration and it can be

0 = full resolution
1 = half resolution
2 = quarter resolution
3 = eighth resolution
...
So if the decodeLevel for a stage is set to 0, then the image will be decoded to full resolution. If it is set to 1, then the image will be decoded to half resolution (x/2, y/2) and so on.

tip
For volume viewports, we currently don't allow decoding into sub-resolution because it would require reallocating the volume in memory, which is inefficient. Therefore, if the data is partial and can't be decoded into full resolution, we simply replicate it (inside a web worker for performance) to fill the entire volume.

However, for the stack viewport, we do allow decoding into sub-resolution since this re-allocation is cheaper than the whole volume. Additionally, in this scneario, future enhanced qualities of the image will wipe out the old image and create a new image with new size until full resolution is reached.

We will talk about frequency in the each method's section below.

Streaming Options
Options
For streaming requests, you can configure the following options:

streaming: whether to use streaming or not
Decoding Frequency
Most often, when the stream is coming from a server, the server lets the client know about the final size of the data. So, at each point in time, we can identify the percentage of the data that has been downloaded and decode the image to the relevant resolution so in the streaming scenario you really don't have to set it manually.

Different levels are, if the downloaded portion at the time of decoding is

< 8 % of the total data, then decode to level 3
8 < x < 13 % of the total data, then decode to level 2
13 < x < 27 % of the total data, then decode to level 1
< 100 (means it is not finished) then decode to level 0
100 % of the total data (stream is finished), then decode to level 0
tip
How did we come up with these levels? It is kind of simple.

For instance, if we have only downloaded 1/16th of the total data, it means we have downloaded 6.25% of the data (8% is 6.25% with some offset). This means we can decode the image to 1/16th of the original size, which is level 4. However, the interpolation provided by the decoder is slightly better than that provided by straight image rendering, and thus one can decode to a slightly lower level, using level 3 instead. The same goes for the rest of the levels.

To answer the question of how many decoding levels will occur, it totally depends on the initial data that is downloaded and how the stream progresses. But at any given time when the data is downloaded, we check the progress against the above levels and decode the image to the relevant resolution if possible. If an error is thrown or the image is not decoded, we simply wait for the next progress event to occur.

Example
For the simple streaming scenario (streaming true) you should expect the following behavior:



Use cases
using the streaming method is suitable for the scenarios that you eventually require the full resolution of the data and you want to start viewing the data as soon as possible.

Byte Range Options
Options
chunkSize: byte range value to retrieve for initial decode (default is 64kb). Ignored for all but the first range request (regardless of rangeIndex).
rangeIndex: is the range number (index) that you want to fetch, -1 for remaining data
Note that there is no guarantee that the rangeIndex will actually fetch another range since it will discontinue fetching once all the data has been fetched. Also, -1 is used to flag the "remaining" data.

Decoding Frequency
There are two scenarios for byte range requests:

If the server sends back the total size of the data in the header of the response for the byte range in which we use our automatic decoding frequency (similar to the streaming scenario).
The server does not send back the total size of the data in the header of the response for the byte range in which we wait until the range request is finished and then decode the image.
tip
The server should send the cors header Access-Control-Expose-Headers: * to enable reading the Range-Response header required for seeing the total size. Otherwise, the range request is finished when the multipart/related header is complete OR the returned data is smaller than the requested data.

Example
For instance for the options of

{
  rangeIndex: 0,
  chunkSize: 256000, // 256kb
}



another example

{
  rangeIndex: 0,
  decodeLevel: 3
}

// chunkSize is default 64kb



tip
You can fetch the remaining data by using rangeIndex: -1. In addition, rangeIndex = 0 will always be the first chunk.

For instance, if you have 4 ranges, then your ranges would be

rangeIndex 0: 0 to chunkSize-1 (in bytes)
rangeIndex 5: chunkSize to 5 * chunkSize-1 (in bytes)
rangeIndex 25: 5 * chunkSize to 25 * chunkSize-1 (in bytes)
rangeIndex -1: 25 * chunkSize to totalSize (in bytes) - the rest of the data
This use of rangeIndex allows retrieving larger increments to agree with the amount of data required for decodeLevel values.

What if I start with a range 1 instead of 0?

Use cases
Other than we can use the range request to progressively request and load a better quality images there are some other usecases

Thumbnails: Often, for thumbnails, we want to load the image as quickly as possible but don't need the full resolution. We can use a byte range request to fetch a lower resolution version of the data.
CINE: For certain imaging needs, the frame rate is absolutely essential in the cine mode. Often, the gross anatomy is desired in these scenarios, not the details, but the frame rate is of greater importance. We can use the byte range request to fetch the subresolution of the data, guaranteeing that we can achieve the target frame rate.
In the future, a separate memory cache might be used for range request details, but right now the intermediate data is held alongside the image data. Storing it in a cache would allow for CINE display with only the cost of decoding the image.

Conclusion
So, we learned that a "retrieve configuration" is composed of at least one (can be more) "retrieve stage" and an accompanying "retrieve options" that have the keys referenced in the "retrieve stages." We also learned that each "retrieve stage" can be configured to use a different method (streaming or byte range) and has common or specific retrieve options.

Let's look at an example of one of the examples that we have in the stackProgressive demo

const retrieveConfiguration = {
  stages: [
    {
      id: 'initialImages',
      retrieveType: 'single',
    },
  ],
  retrieveOptions: {
    single: {
      streaming: true,
    },
  },
};

tip
Note the common use of 'single' in both the stages and retrieveOptions objects. This is just a reference to the retrieve options that we have defined in the retrieveOptions object.

Now your question might be, how do we use this configuration? We will talk about that in the next section. But curious readers can move to the advanced configuration section to learn more about the advanced options that we have for the retrieve configuration.

dvance Options
There are more advanced options both for retrieve stages and also for retrieve options that can be used to customize the behavior of the progressive loading.

tip
You can skip this section if you are not interested in the advanced options (yet) and still move to the usage section. Basically, some of these options (position, decimate, offset, priority, and nearbyFrames) are used in the "volume progressive" example, which you can revisit later.

Advanced Retrieve Stages Options
positions?: number[];
Used for volume-progressive loading, where we need to specify the exact image index we want to retrieve. This is generally true in general hanging protocols, as the initial image is usually in the middle, top, or bottom of the stack.

You can use absolution positions, or relative positions between [0, 1]. Positions less than 0 are relative to the end, so you can use -1 to indicate the last image in the stack.

Example

stages: [
  {
    id: 'initialImages',
    positions: [0.5, 0, -1],
    retrieveType: 'initial', // arbitrary naming as discussed
  },
];


in the above example, we are requesting the middle image, the first image, and the last image in the stack.

tip
To retrieve another initial image automatically based on initial display positions, copy the stages, and add a new stage with your desired position, putting that stage first. This can be used to ensure the initial image is fetched.

decimate?: number & offset?: number;
By utilizing the decimate and offset features, we can enhance the flexibility of specifying the desired images for retrieval. For example, if a volume comprises 100 images, applying a decimate value of 2 and an offset of 0 will retrieve images 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, and so on. Similarly, employing a decimate value of 2 and an offset of 1 will retrieve images 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, and so forth. This demonstrates how we can effectively interleave the images by leveraging different offsets and decimate values.

It is safe to repeat image fetches, as the fetches will be discarded when the image quality status is already better than that of the specified fetch.

stages: [
  {
    id: 'initialImages',
    positions: [0.5, 0, -1],
    retrieveType: 'initial', // arbitrary naming as discussed
  },
  {
    id: 'initialPass',
    decimate: 2,
    offset: 0,
    retrieveType: 'fast', // arbitrary naming as discussed
  },
  {
    id: 'secondPass',
    decimate: 2,
    offset: 1,
    retrieveType: 'fast', // arbitrary naming as discussed
  },
];


Above we have three stages where we first retrieve the initial images, then we retrieve the rest of the images in two passes. The first pass will retrieve images 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, and so on. The second pass will retrieve images 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, and so forth.

priority?: number & requestType
Using combination of requestType (thumbnail, prefetch, interaction) and priority (the lower the higher) you can effectively prioritize the requests. For example, you can set the priority of the initial images to be higher (lower number) than the rest of the images. This will ensure that the initial images are retrieved first in the queue.

stages: [
  {
    id: 'initialImages',
    positions: [0.5, 0, -1],
    retrieveType: 'initial',
    requestType: RequestType.INTERACTION,
    priority: -1,
  },
  {
    id: 'initialPass',
    decimate: 2,
    offset: 0,
    retrieveType: 'fast',
    priority: 2,
    requestType: RequestType.PREFETCH,
  },
  {
    id: 'secondPass',
    decimate: 2,
    offset: 1,
    retrieveType: 'fast',
    priority: 3,
    requestType: RequestType.PREFETCH,
  },
];

tip
Set the maximum number of requests to run to a lower value to ensure that your required requests are performed first. For example:

imageLoadPoolManager.setMaxSimultaneousRequests(RequestType.INTERACTION, 6);


nearbyFrames?: NearbyFrames[];
Using nearby frames, you have the option to fill in the nearby frames to instantaneously fill and render the empty spaces in the volume.

Example

stages: [
  {
    id: 'initialPass',
    decimate: 2,
    offset: 0,
    retrieveType: 'fast',
    priority: 2,
    requestType: RequestType.PREFETCH,
    nearbyFrames: [
      {
        offset: +1,
        imageQualityStatus: ImageQualityStatus.ADJACENT_REPLICATE,
      },
    ],
  },
  {
    id: 'secondPass',
    decimate: 2,
    offset: 1,
    retrieveType: 'fast',
    priority: 3,
    requestType: RequestType.PREFETCH,
  },
];


In the above, we are specifying that we would like to replicate the adjacent frames to the current frame (+1). This way, until the next stage (secondPass) arrives, we will have the adjacent frames ready to be rendered and displayed. The secondPass will overwrite them with actual data.

Advanced Retrieve Options
urlArguments
urlArguments - is a set of arguments to add to the URL
This distinguishes this request from other requests which cannot be combined with this one
The DICOMweb standard allows for the accept parameter to specify a content type
The HTJ2K content type is image/jhc
The configuration for this is (assuming standards based DICOMweb support):

retrieveOptions: {
  default: {
    urlArguments: 'accept=image/jhc',
    rangeIndex: -1,
  },
  multipleFast: {
    urlArguments: 'accept=image/jhc',
    rangeIndex: 0,
    decodeLevel: 0,
  },
},

warning
You MUST repeat the same framesPath and urlArguments for each stage in a range request, otherwise the assumption is that the data retrieved in the first range is NOT the same data retrieved in the second range, and the second range request will just retrieve the entire request.

framePath
framesPath - to update the URL path portion
This is useful for fetching another available path such as the thumbnail, JPIP or rendered endpoints for lossy encoded retrieves as they are located on different paths than the lossless encoded images.

This is also useful for integration with fixed path alternate encoding servers which choose the response to return based on the URL path, storing various lossy renderings on alternate paths.

imageQualityStatus
imageQualityStatus - used to set the retrieve status to lossy or sub-resolution
This is typically used when the URL or retrieve parameters specify a lossy final rendering of the given path such as for a lossy encoded HTJ2K image.

Separate URL For Sub-Resolution Images
An alternative to a byte range request is to make an different request for a complete, but lossy/low resolution image. This can be standards based assuming the DICOMweb supports JPIP, or more likely is non-standards based using a separate path for the low resolution fetch.

For the JPIP approach shown here, the JPIP server must expose an endpoint identical in path to the normal pixel data endpoint, except ending in /jpip?target=<FRAMENO>, and supporting the fsiz parameter. See Part 5 and Part 18 of the DICOM standard.

For the non-standard path approach, the assumption is that there are other endpoints related to the normal /frames endpoint, except that the /frames/ part of the URL is replaced by another value. For example, this could be used to fetch a /jlsThumbnail/ data as used in the stackProgressive example.

An example configuration for JPIP:

  retrieveOptions: {
    default: {
      // Need to note this is a lossy encoding, as it isn't possible to
      // detect based on the general configuration here.
      imageQualityStatus: ImageQualityStatus.SUBRESOLUTION,
      // Hypothetical JPIP server using a path that is the normal DICOMweb
      // path but with /jpip?target= replacing the /frames path
      // This uses the standards based target JPIP parameter, and assigns
      // the frame number as the value here.
      framesPath: '/jpip?target=',
      // Standards based fsiz parameter retrieves a sub-resolution image
      urlArguments: 'fsiz=128,128',
    },
  },

Usage
Now that we have learned about the retrieve configuration, let's see how we can use it in Cornerstone3D.

imageRetrieveMetadataProvider
This is a new metadata provider that we have added to the Cornerstone3D library. It is responsible for retrieving the metadata for the image (or volume, as we will explore later). So, in order to perform progressive loading on a set of imageIds, you need to add your retrieve configuration to this provider.

Stack Viewport
You can specify an imageId-specific retrieve configuration by including the imageIds as the key for your metadata. Considering our one stage retrieve configuration from the previous section we have the following:

import { utilities } from '@cornerstone3d/core';

const retrieveConfiguration = {
  stages: [
    {
      id: 'initialImages',
      retrieveType: 'single',
    },
  ],
  retrieveOptions: {
    single: {
      streaming: true,
    },
  },
};

utilities.imageRetrieveMetadataProvider.add('imageId1', retrieveConfiguration);


If you don't need to define an imageId-specific retrieve configuration, you can then scope your metadata to stack in order for it to be applied to all imageIds.

utilities.imageRetrieveMetadataProvider.add('stack', retrieveConfiguration);


Volume Viewport
For loading a volume as progressive loading, you can use the volumeId as the key for your metadata.

import { utilities } from '@cornerstone3d/core';

const volumeId = ....get volume id....
utilities.imageRetrieveMetadataProvider.add(volumeId, retrieveConfiguration);


Or you can scope your metadata to volume in order for it to be applied to all volumeIds.

utilities.imageRetrieveMetadataProvider.add('volume', retrieveConfiguration);


tip
That is all you need to do! Everything else for loading the image progressively is handled by the Cornerstone3D library.

etail, including scenarios that involve multiple stages of progressive loading and different retrieval types.

tip
For stacked viewports, larger images can be decoded using a streaming method, where the HTJ2K RPCL image is received as a stream, and parts of it are decoded as they become available. This can significantly improve the viewing of stacked images, without requiring any special server requirements other than support for the HTJ2K RPCL transfer syntax.

Benchmark
In general, about 1/16th to 1/10th of the image is retrieved for the lossy/first version of the image. This results in a significant speed improvement for the first images. It is fairly strongly affected by the overall image size, network performance, and compression ratios.

**The full size test image is 3036 x 3036 and 11.1 MB in size. **

Type	Network	Size	First Render	Final Render (baseline)
HTJ2K streaming (1 stage)	4g	11.1 M	66 ms	5053 ms
HTJ2K Byte Range (2 stages)	4g	128 K	45 ms	4610 ms
The configuration for the above test is as follows

HTJ2K Streaming (1 stage)
This configuration will retrieve an image using a single stage streaming response. It is safe to use for both streaming and non-streaming transfer syntaxes, but will only activate for the decoding portion when used with HTJ2K transfer syntaxes. For HTJ2K decoding, if the image is NOT in RPCL format, then other decoding progressions may occur, such as decoding by by region (eg top-left, top-right, bottom-left, bottom-right), or decoding may fail until the full data is available.

tip
You can use urlParameters: accept=image/jhc to request HTJ2K in a standards compliant fashion.

const retrieveConfiguration = {
  // stages defaults to singleRetrieveConfiguration
  retrieveOptions: {
    single: {
      streaming: true,
    },
  },
};

HTJ2K Byte Range (2 stages)
This sequential retrieve configuration has two stages specified, each of which applies to the entire stack of image ids. The first stage will load every image using the singleFast retrieve type, followed by the second stage retrieving using singleFinal.

Note that this retrieve configuration requires support for byte-range requests on the server side. It MAY be safe for servers not supporting byte range requests, but the requests may also fail when attempted. Read your DICOM Conformance Statement.

tip
You can add a third, error recovery stage removing any byte range requests. This stage will only end up being run if the previous stages fail. This allows dealing with unknown server support.

const retrieveConfiguration = {
  // This stages list is available as sequentialRetrieveStages
  stages: [
    {
      id: 'lossySequential',
      retrieveType: 'singleFast',
    },
    {
      id: 'finalSequential',
      retrieveType: 'singleFinal',
    },
  ],
  retrieveOptions: {
    singleFast: {
      rangeIndex: 0,
      decodeLevel: 3,
    },
    singleFinal: {
      rangeIndex: -1,
    },
  },
};

Volume Progressive Loading
Volume Viewport Interleaved Decode
Since, for volume viewports, we mostly deal with rendering the reconstructed views (MPR) of the actual volume, the ideal scenario would be to have the initial images of the volume (even if lossy) as quickly as possible to avoid rendering a gray volume. We can achieve this by interleaving the requests.

Interleaving the images applies to any encoding for a volume. That is, fetching every Nth image first allows a 1/Nth frequency image to be displayed. The interleave code then simply replicates the images to the missing positions to produce a low resolution in the longitudinal direction.

This interleaving can then be combined with any discrete fetch for a lossy version of an image - that is, a non-streamed decoding version of an image that returns an entire request at once.

Performance
The performance gains on using progressive loading on volume viewports vary quite a bit depending on size of data and capabilities of the DICOMweb server components.

Note that none of the times include time to load the decoder, but is only seen on first render. These times are similar for both types.

Type	Size	Network	First Render	Complete
HTJ2K Stream	33 M	4g	2503 ms	8817 ms
HTJ2K Byte Range	33 M	4g	1002 ms	8813 ms
The HTJ2K byte range is very slightly slower than straight JLS, but can be done against any DICOMweb server supporting HTJ2K and byte range requests.

4g speed - 30 mbit/s down, 5 mbit/s up, 10 ms latency
Full size images are 512x512x174
Reduce resolution images are 128x128 and lossy compressed
HTJ2K Streaming
Note that this stage model will interleave requests across different viewports for the various stages, by the selection of the queue and the priority of the requests. The interleaving isn't perfect, as it interleaves stages rather than individual requests, but the appearance works reasonably well without complex logic being needed to work between volumes.

As learned in the advanced retrieve configuration, we saw that we can make use of decimate, offset and different priorities to achieve the interleaving.

Decimation is a selection of every Nth' image at the F offset, described as N/F, eg 4/3 is positions 3,7,11,... This is done by retrieving, in order, the following stages:

Initial images - images at position 0, 50%, 100%
Decimated 4/3 image using multipleFast retrieve type
Displays a full volume at low resolution once this is complete
Decimated 4/1 image using multipleFast retrieve type
Updates the initial volume with twice the resolution
Decimated 4/2 and 4/0 images using multipleFinal
Replaces the replicated images with full resolution images
Decimated 4/3 and 4/1 using multipleFinal
Replices the low resolution images with full resolution
The configuration looks like:

  stages: [
    {
      id: 'initialImages',
      // positions selects specific positions - middle image, first and last
      positions: [0.5, 0, -1],
      // Use teh default render type for these, which should retrieve full resolution
      retrieveType: 'default',
      // Use the Interaction queue
      requestType: RequestType.INTERACTION,
      // Priority 10, do first
      priority: 10,
      // Fill nearby frames from this data
      nearbyFrames: {....},
    },
    {
      id: 'quarterThumb',
      decimate: 4,
      offset: 3,
      retrieveType: 'multipleFast',
      priority: 9,
      nearbyFrames,
    },
    ... other versions
    // Replace the first data with final data
    {
      id: 'finalFull',
      decimate: 4,
      offset: 3,
      priority: 4,
      retrieveType: 'multipleFinal',
    },
  ],


Fetch images shown initially at full resolution (first and last)
Fetch every 4th image first initialByteRange bytes
Fetch byte range [0,64000]
Display partial resolution version immediately
Use partial resolution version to display nearby slices
Other steps
There are other partial and full resolution views here to fill in data
Fetch remaining data for #2 (do not refetch original data)
Replaces the low resolution data from #2 with full data
HTJ2K Byte Range
The volume progressive loading extends the basic stack loading with the ability to interleave various images, interpolating them from a reduced resolution version both intra and inter image. That is, individual images might be fetched initially at 1/4 size (256x256 for a CT), and then only the initially displayed image plus every 4th image, with other images being interpolated. In this case, replicate interpolation is used to minimize interpolation overhead. Finally, after the lossy initial versions are fetched, the remaining images are fetched.

The default retrieve ordering is below, where Decimate is described as the interval between images included, and the offset in that set.

Initial images, full resolution
Decimate 4/3 partial resolution
Interpolate images -2...+1 (nearest neighbors)
Decimate 4/1 partial resolution
Decimate 4/2 full resolution
Decimate 4/4 full resolution
Decimate 4/3 full resolution
Decimate 4/1 full resolution
The same ordering is done if partial resolution is not configured, except that the last two stages are never run because the partial resolution has already loaded those. This DOES allow the interpolation of results to appear very quickly.

Progressive Loading for non-HTJ2K Progressive Encoded Data
JLS Thumbnails
JLS thumbnails can be created using the static-dicomweb toolkit, for example, by doing:

# Create a JLS directory containing JLS encoded data in the /jls sub-path
mkdicomweb create -t jhc --recompress true --alternate jlsLossless --alternate-name jls "/dicom/DE Images for Rad"
# Create a jlsThumbnail sub-directory containing reduce resolution data
mkdicomweb create -t jhc --recompress true --alternate jls --alternate-name jlsThumbnail --alternate-thumbnail "/dicom/DE Images for Rad"


This can then be used by configuring:

cornerstoneDicomImageLoader.configure({
  retrieveOptions: {
    default: {
      default: {
        framesPath: '/jls/',
      },
    },
    singleFast: {
      default: {
        imageQualityStatus: ImageQualityStatus.SUBRESOLUTION,
        framesPath: '/jlsThumbnail/',


Sequential Retrieve Configuration
The sequential retrieve configuration has two stages specified, each of which applies to the entire stack of image ids. The first stage will load every image using the singleFast retrieve type, followed by the second stage retrieving using singleFinal. If the first stage results in lossless images, the second stage never gets run, and thus the behaviour is identical to previous behaviour for stack images.

This configuration can also be used for volumes, producing the old/previous behaviour for streaming volume loading.

The configuration is:

stages: [
    {
      id: 'lossySequential',
      retrieveType: 'singleFast',
    },
    {
      id: 'finalSequential',
      retrieveType: 'singleFinal',
    },
  ],

Images for the stack viewport can be loaded with a lower resolution/lossy version first, followed by increasingly higher resolutions, and finally the final version being a lossless representation.

For HTJ2K, this is done automatically when the image is encoded in progressive resolution order by using a streaming reader that returns lower resolution versions of the image as they are available.

For other image types, a separate lower resolution/lossy version is required. The Static DICOMweb toolkit includes some options to create such images.

Performance
In general, about 1/16-1/10th of the image is retrieved for the lossy/first version of the image. This results in a significant speed improvement to first images. It is affected fairly strongly by overall image size, network performance and compression ratios.

The full size images are 3036 x 3036, while the JLS reduced images are 759 x 759

Type	Network	Size	First Render	Final Render
JLS	4g	10.6 M		4586 ms
JLS Reduced	4g	766 K	359 ms	4903 ms
HTJ2K	4g	11.1 M	66 ms	5053 ms
HTJ2K Byte Range	4g	128 K	45 ms	4610 ms
JLS Reduced uses 1/16 size JLS 'thumbnails'
HTJ2K uses streaming data
HTJ2K Byte Range uses 64k initial retrieve, followed by remaining data
Interleave performance
that none of the times include time to load the decoder, which can be a second or more, but is only seen on first render. These times are similar for both types.

Type	Size	Network	First Render	Complete
JLS	30 M	4g	2265 ms	8106 ms
JLS Reduced	3.6 M	4g	1028 ms	8455 ms
HTJ2K	33 M	4g	2503 ms	8817 ms
HTJ2K Byte Range	11.1M	4g	1002 ms	8813 ms
JLS	30 M	local	1322 ms	1487 ms
JLS Reduced	3.6 M	local	1084 ms	1679 ms
HTJ2K	33 M	local	1253 ms	1736 ms
HTJ2K Byte Range	11.1M	local	1359 ms	1964 ms
The HTJ2K byte range is very slightly slower than straight JLS, but can be done against any DICOMweb server supporting HTJ2K and byte range requests.

4g speed - 30 mbit/s down, 5 mbit/s up, 10 ms latency
Complete time for the JLS and HTJ2K was essentially identical to baseline non-progressive
Full size images are 512x512
Reduce resolution images are 128x128 and lossy compressed
Configuration
See the stackProgressive example for stack details.

Stack viewports need to be configured for progressive streaming by registering metadata for the imageId or the default stack metadata as an IRetrieveConfiguration value. This value contains the stages to run, as well as the retrieve configuration for each stage. In specific, the streaming value needs to be set on the retrieve configuration for the value single retrieveType.

The retrieve configuration has two pieces, the stages and the retrieve options (additionally, it can completely replace the retriever with a custom one). The stages are used to select the image ID's to retrieve, and provide the retrieve type to use. Then, the retrieve options map the retrieve type to the actual options to use. That allows multiple stages to use the same retrieve type for different purposes.

The two retrieve types used for the progressive rendering for stack (which is defined in sequentialRetrieveConfiguration) are singleFast and singleFinal. This allows differing requests to be made for a fast initial request and a final, lossless request. The example stackProgressive shows several possible configurations for this which demonstrate how to load different URL paths or different parts of the image across repeated requests using byte range retrieves.
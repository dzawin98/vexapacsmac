export type ViewerOverlayCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'

export type ViewerOverlayLayout = Record<ViewerOverlayCorner, string[]>

export type ViewerOverlayConfig = {
  version: 2
  profiles: Record<string, ViewerOverlayLayout>
}

export type ViewerOverlayFieldDefinition = {
  id: string
  label: string
  group: 'Patient' | 'Study' | 'Series' | 'Acquisition' | 'Image'
  preview: string
  families?: OverlayModalityFamily[]
}

export type OverlayModalityFamily = 'ct' | 'mr' | 'nuclear' | 'radiography' | 'angiography' | 'ultrasound' | 'waveform'

export type OverlayModalityDefinition = {
  code: string
  label: string
  category: string
  family?: OverlayModalityFamily
}

export const defaultOverlayProfileId = 'DEFAULT'

export const overlayCorners: Array<{ id: ViewerOverlayCorner; label: string }> = [
  { id: 'topLeft', label: 'Top Left' },
  { id: 'topRight', label: 'Top Right' },
  { id: 'bottomLeft', label: 'Bottom Left' },
  { id: 'bottomRight', label: 'Bottom Right' },
]

// DICOM PS3.16 2026c CID 33 (CID 29, 32, and 34), supplemented with
// current PS3.3 RT Second Generation and XA Protocol defined terms.
// Retired values remain configurable for compatibility with historical studies.
export const overlayModalityDefinitions: OverlayModalityDefinition[] = [
  { code: 'CT', label: 'Computed Tomography', category: 'Cross-sectional', family: 'ct' },
  { code: 'MR', label: 'Magnetic Resonance', category: 'Cross-sectional', family: 'mr' },
  { code: 'NM', label: 'Nuclear Medicine', category: 'Cross-sectional', family: 'nuclear' },
  { code: 'PT', label: 'Positron Emission Tomography', category: 'Cross-sectional', family: 'nuclear' },

  { code: 'CR', label: 'Computed Radiography', category: 'Projection X-ray', family: 'radiography' },
  { code: 'DX', label: 'Digital Radiography', category: 'Projection X-ray', family: 'radiography' },
  { code: 'MG', label: 'Mammography', category: 'Projection X-ray', family: 'radiography' },
  { code: 'IO', label: 'Intra-oral Radiography', category: 'Projection X-ray', family: 'radiography' },
  { code: 'PX', label: 'Panoramic X-Ray', category: 'Projection X-ray', family: 'radiography' },
  { code: 'RG', label: 'Radiographic Imaging', category: 'Projection X-ray', family: 'radiography' },
  { code: 'RF', label: 'Radiofluoroscopy', category: 'Projection X-ray', family: 'angiography' },
  { code: 'XA', label: 'X-Ray Angiography', category: 'Projection X-ray', family: 'angiography' },
  { code: 'RTIMAGE', label: 'RT Image', category: 'Projection X-ray', family: 'radiography' },

  { code: 'US', label: 'Ultrasound', category: 'Ultrasound and clinical', family: 'ultrasound' },
  { code: 'BDUS', label: 'Ultrasound Bone Densitometry', category: 'Ultrasound and clinical', family: 'ultrasound' },
  { code: 'ES', label: 'Endoscopy', category: 'Ultrasound and clinical' },
  { code: 'PA', label: 'Photoacoustic', category: 'Ultrasound and clinical' },
  { code: 'TG', label: 'Thermography', category: 'Ultrasound and clinical' },
  { code: 'BI', label: 'Biomagnetic Imaging', category: 'Ultrasound and clinical' },
  { code: 'BMD', label: 'Bone Mineral Densitometry', category: 'Ultrasound and clinical' },
  { code: 'DG', label: 'Diaphanography', category: 'Ultrasound and clinical' },

  { code: 'AR', label: 'Autorefraction', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'CFM', label: 'Confocal Microscopy', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'DMS', label: 'Dermoscopy', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'GM', label: 'General Microscopy', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'IVOCT', label: 'Intravascular Optical Coherence Tomography', category: 'Ophthalmic, microscopy, and surface', family: 'ultrasound' },
  { code: 'IVUS', label: 'Intravascular Ultrasound', category: 'Ophthalmic, microscopy, and surface', family: 'ultrasound' },
  { code: 'KER', label: 'Keratometry', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'LEN', label: 'Lensometry', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'LS', label: 'Laser Surface Scan', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OAM', label: 'Ophthalmic Axial Measurements', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OCT', label: 'Optical Coherence Tomography', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OP', label: 'Ophthalmic Photography', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OPM', label: 'Ophthalmic Mapping', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OPT', label: 'Ophthalmic Tomography', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OPTBSV', label: 'Ophthalmic Tomography B-scan Volume Analysis', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OPTENF', label: 'Ophthalmic Tomography En Face', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OPV', label: 'Ophthalmic Visual Field', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'OSS', label: 'Optical Surface Scanner', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'SM', label: 'Slide Microscopy', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'SRF', label: 'Subjective Refraction', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'VA', label: 'Visual Acuity', category: 'Ophthalmic, microscopy, and surface' },
  { code: 'XC', label: 'External-camera Photography', category: 'Ophthalmic, microscopy, and surface' },

  { code: 'ECG', label: 'Electrocardiography', category: 'Waveform', family: 'waveform' },
  { code: 'EEG', label: 'Electroencephalography', category: 'Waveform', family: 'waveform' },
  { code: 'EMG', label: 'Electromyography', category: 'Waveform', family: 'waveform' },
  { code: 'EOG', label: 'Electrooculography', category: 'Waveform', family: 'waveform' },
  { code: 'EPS', label: 'Cardiac Electrophysiology', category: 'Waveform', family: 'waveform' },
  { code: 'HD', label: 'Hemodynamic', category: 'Waveform', family: 'waveform' },
  { code: 'POS', label: 'Position Sensor', category: 'Waveform', family: 'waveform' },
  { code: 'RESP', label: 'Respiratory Waveform', category: 'Waveform', family: 'waveform' },

  { code: 'ASMT', label: 'Content Assessment Result', category: 'Derived, document, and RT' },
  { code: 'AU', label: 'Audio', category: 'Derived, document, and RT' },
  { code: 'CTPROTOCOL', label: 'CT Protocol', category: 'Derived, document, and RT' },
  { code: 'DOC', label: 'Document', category: 'Derived, document, and RT' },
  { code: 'FID', label: 'Spatial Fiducials', category: 'Derived, document, and RT' },
  { code: 'HC', label: 'Hard Copy', category: 'Derived, document, and RT' },
  { code: 'IOL', label: 'Intraocular Lens Calculation', category: 'Derived, document, and RT' },
  { code: 'KO', label: 'Key Object Selection', category: 'Derived, document, and RT' },
  { code: 'M3D', label: '3D Manufacturing Modeling System', category: 'Derived, document, and RT' },
  { code: 'OT', label: 'Other Modality', category: 'Derived, document, and RT' },
  { code: 'PLAN', label: 'Plan', category: 'Derived, document, and RT' },
  { code: 'PR', label: 'Presentation State', category: 'Derived, document, and RT' },
  { code: 'REG', label: 'Registration', category: 'Derived, document, and RT' },
  { code: 'RTDOSE', label: 'RT Dose', category: 'Derived, document, and RT' },
  { code: 'RTINTENT', label: 'Radiotherapy Intent', category: 'Derived, document, and RT' },
  { code: 'RTPLAN', label: 'RT Plan', category: 'Derived, document, and RT' },
  { code: 'RTRAD', label: 'RT Radiation', category: 'Derived, document, and RT' },
  { code: 'RTRECORD', label: 'RT Treatment Record', category: 'Derived, document, and RT' },
  { code: 'RTSEGANN', label: 'Radiotherapy Segment Annotation', category: 'Derived, document, and RT' },
  { code: 'RTSTRUCT', label: 'RT Structure Set', category: 'Derived, document, and RT' },
  { code: 'RWV', label: 'Real World Value Map', category: 'Derived, document, and RT' },
  { code: 'SEG', label: 'Segmentation', category: 'Derived, document, and RT' },
  { code: 'SMR', label: 'Stereometric Relationship', category: 'Derived, document, and RT' },
  { code: 'SR', label: 'Structured Report Document', category: 'Derived, document, and RT' },
  { code: 'STAIN', label: 'Automated Slide Stainer', category: 'Derived, document, and RT' },
  { code: 'TEXTUREMAP', label: 'Texture Map', category: 'Derived, document, and RT' },
  { code: 'XAPROTOCOL', label: 'XA Protocol', category: 'Derived, document, and RT' },

  { code: 'AS', label: 'Angioscopy (retired)', category: 'Legacy compatibility', family: 'angiography' },
  { code: 'CD', label: 'Color Flow Doppler (retired)', category: 'Legacy compatibility', family: 'ultrasound' },
  { code: 'CF', label: 'Cinefluorography (retired)', category: 'Legacy compatibility', family: 'angiography' },
  { code: 'CP', label: 'Culposcopy (retired)', category: 'Legacy compatibility' },
  { code: 'CS', label: 'Cystoscopy (retired)', category: 'Legacy compatibility' },
  { code: 'DD', label: 'Duplex Doppler (retired)', category: 'Legacy compatibility', family: 'ultrasound' },
  { code: 'DF', label: 'Digital Fluoroscopy (retired)', category: 'Legacy compatibility', family: 'angiography' },
  { code: 'DM', label: 'Digital Microscopy (retired)', category: 'Legacy compatibility' },
  { code: 'DS', label: 'Digital Subtraction Angiography (retired)', category: 'Legacy compatibility', family: 'angiography' },
  { code: 'EC', label: 'Echocardiography (retired)', category: 'Legacy compatibility', family: 'ultrasound' },
  { code: 'FA', label: 'Fluorescein Angiography (retired)', category: 'Legacy compatibility' },
  { code: 'FS', label: 'Fundoscopy (retired)', category: 'Legacy compatibility' },
  { code: 'LP', label: 'Laparoscopy (retired)', category: 'Legacy compatibility' },
  { code: 'MA', label: 'MR Angiography (retired)', category: 'Legacy compatibility', family: 'mr' },
  { code: 'MS', label: 'MR Spectroscopy (retired)', category: 'Legacy compatibility', family: 'mr' },
  { code: 'OPR', label: 'Ophthalmic Refraction (retired)', category: 'Legacy compatibility' },
  { code: 'ST', label: 'SPECT (retired)', category: 'Legacy compatibility', family: 'nuclear' },
  { code: 'VF', label: 'Videofluorography (retired)', category: 'Legacy compatibility', family: 'angiography' },
]

export const overlayFieldDefinitions: ViewerOverlayFieldDefinition[] = [
  { id: 'patientName', label: 'Patient Name', group: 'Patient', preview: 'BUDI SANTOSO SIMULASI' },
  { id: 'patientId', label: 'Patient ID', group: 'Patient', preview: 'SIMRS-20260615-001' },
  { id: 'birthDate', label: 'Birth Date', group: 'Patient', preview: 'DOB: 08/17/1985' },
  { id: 'sex', label: 'Sex', group: 'Patient', preview: 'Sex: M' },
  { id: 'age', label: 'Age', group: 'Patient', preview: 'Age: 40Y' },
  { id: 'weight', label: 'Weight', group: 'Patient', preview: 'Weight: 72 kg' },
  { id: 'patientSize', label: 'Patient Size', group: 'Patient', preview: 'Height: 1.72 m' },
  { id: 'patientPosition', label: 'Patient Position', group: 'Patient', preview: 'Position: HFS' },

  { id: 'modalityStudy', label: 'Modality and Study', group: 'Study', preview: 'CT - CT Kepala Polos' },
  { id: 'studyDateTime', label: 'Study Date and Time', group: 'Study', preview: '06/15/2026, 23:22:49' },
  { id: 'studyDescription', label: 'Study Description', group: 'Study', preview: 'Study: CT Kepala Polos' },
  { id: 'accessionNumber', label: 'Accession Number', group: 'Study', preview: 'ACC: RAD-20260615-001' },
  { id: 'studyId', label: 'Study ID', group: 'Study', preview: 'Study ID: 20260615' },
  { id: 'referringPhysician', label: 'Referring Physician', group: 'Study', preview: 'Ref: dr. Rehatta' },
  { id: 'institutionName', label: 'Institution', group: 'Study', preview: 'RSUD dr. Rehatta' },
  { id: 'modalitiesInStudy', label: 'Modalities in Study', group: 'Study', preview: 'Modalities: CT' },
  { id: 'studyUid', label: 'Study Instance UID', group: 'Study', preview: 'Study UID: 1.2.826.0.1...' },

  { id: 'seriesInfo', label: 'Series Description', group: 'Series', preview: 'Head 1.0 H31s 3D' },
  { id: 'seriesNumber', label: 'Series Number', group: 'Series', preview: 'Series: 4' },
  { id: 'seriesDateTime', label: 'Series Date and Time', group: 'Series', preview: 'Series: 06/15/2026, 23:22:49' },
  { id: 'protocolName', label: 'Protocol Name', group: 'Series', preview: 'Protocol: 1_Head' },
  { id: 'bodyPart', label: 'Body Part', group: 'Series', preview: 'Body Part: HEAD' },
  { id: 'laterality', label: 'Laterality', group: 'Series', preview: 'Laterality: R' },
  { id: 'viewPosition', label: 'View Position', group: 'Series', preview: 'View: AP' },
  { id: 'imageType', label: 'Image Type', group: 'Series', preview: 'Type: ORIGINAL\\PRIMARY' },
  { id: 'manufacturer', label: 'Manufacturer', group: 'Series', preview: 'Manufacturer: Siemens' },
  { id: 'modelName', label: 'Model Name', group: 'Series', preview: 'Model: SOMATOM' },
  { id: 'stationName', label: 'Station Name', group: 'Series', preview: 'Station: CT-01' },
  { id: 'operatorName', label: 'Operator Name', group: 'Series', preview: 'Operator: RAD TECH' },
  { id: 'seriesUid', label: 'Series Instance UID', group: 'Series', preview: 'Series UID: 1.3.12.2...' },

  { id: 'kvp', label: 'KVP', group: 'Acquisition', preview: 'KVP: 130', families: ['ct', 'radiography', 'angiography'] },
  { id: 'tubeCurrent', label: 'X-Ray Tube Current', group: 'Acquisition', preview: 'mA: 77', families: ['ct', 'radiography', 'angiography'] },
  { id: 'exposureTime', label: 'Exposure Time', group: 'Acquisition', preview: 'ET: 1500', families: ['ct', 'radiography', 'angiography'] },
  { id: 'exposure', label: 'Exposure', group: 'Acquisition', preview: 'Exposure: 116', families: ['ct', 'radiography', 'angiography'] },
  { id: 'ctdiVol', label: 'CTDIvol', group: 'Acquisition', preview: 'CTDIvol: 50.88', families: ['ct'] },
  { id: 'pitch', label: 'Spiral Pitch', group: 'Acquisition', preview: 'Pitch: 0.55', families: ['ct'] },
  { id: 'kernel', label: 'Reconstruction Kernel', group: 'Acquisition', preview: 'Kernel: H31s', families: ['ct'] },
  { id: 'gantryTilt', label: 'Gantry/Detector Tilt', group: 'Acquisition', preview: 'Tilt: 0.0 deg', families: ['ct'] },
  { id: 'rotationTime', label: 'Rotation Time', group: 'Acquisition', preview: 'Rotation: 0.50 s', families: ['ct'] },
  { id: 'totalCollimationWidth', label: 'Total Collimation Width', group: 'Acquisition', preview: 'Collimation: 38.4 mm', families: ['ct'] },
  { id: 'tableFeedPerRotation', label: 'Table Feed per Rotation', group: 'Acquisition', preview: 'Table feed: 21.1 mm', families: ['ct'] },
  { id: 'dataCollectionDiameter', label: 'Data Collection Diameter', group: 'Acquisition', preview: 'Collection: 500.0 mm', families: ['ct'] },
  { id: 'filterType', label: 'Filter Type', group: 'Acquisition', preview: 'Filter: STANDARD', families: ['ct'] },
  { id: 'contrastAgent', label: 'Contrast Agent', group: 'Acquisition', preview: 'Contrast: Iopamidol' },
  { id: 'scanOptions', label: 'Scan Options', group: 'Acquisition', preview: 'Scan: HELICAL MODE', families: ['ct', 'mr'] },
  { id: 'acquisitionNumber', label: 'Acquisition Number', group: 'Acquisition', preview: 'Acq: 1' },

  { id: 'tr', label: 'Repetition Time', group: 'Acquisition', preview: 'TR: 4500.0', families: ['mr'] },
  { id: 'te', label: 'Echo Time', group: 'Acquisition', preview: 'TE: 100.0', families: ['mr'] },
  { id: 'ti', label: 'Inversion Time', group: 'Acquisition', preview: 'TI: 900.0', families: ['mr'] },
  { id: 'flipAngle', label: 'Flip Angle', group: 'Acquisition', preview: 'FA: 90.0', families: ['mr'] },
  { id: 'fieldStrength', label: 'Magnetic Field Strength', group: 'Acquisition', preview: 'B: 1.50 T', families: ['mr'] },
  { id: 'scanningSequence', label: 'Scanning Sequence', group: 'Acquisition', preview: 'Sequence: SE', families: ['mr'] },
  { id: 'sequenceVariant', label: 'Sequence Variant', group: 'Acquisition', preview: 'Variant: SK', families: ['mr'] },
  { id: 'mrAcquisitionType', label: 'MR Acquisition Type', group: 'Acquisition', preview: 'MR Acq: 3D', families: ['mr'] },
  { id: 'sequenceName', label: 'Sequence Name', group: 'Acquisition', preview: 'Name: t1_mprage', families: ['mr'] },
  { id: 'echoNumber', label: 'Echo Number', group: 'Acquisition', preview: 'Echo: 1', families: ['mr'] },
  { id: 'echoTrainLength', label: 'Echo Train Length', group: 'Acquisition', preview: 'ETL: 16', families: ['mr'] },
  { id: 'imagingFrequency', label: 'Imaging Frequency', group: 'Acquisition', preview: 'Freq: 63.86 MHz', families: ['mr'] },
  { id: 'imagedNucleus', label: 'Imaged Nucleus', group: 'Acquisition', preview: 'Nucleus: 1H', families: ['mr'] },
  { id: 'phaseEncodingDirection', label: 'In-plane Phase Encoding', group: 'Acquisition', preview: 'Phase: ROW', families: ['mr'] },
  { id: 'acquisitionMatrix', label: 'Acquisition Matrix', group: 'Acquisition', preview: 'Acq matrix: 256 x 192', families: ['mr'] },
  { id: 'triggerTime', label: 'Trigger Time', group: 'Acquisition', preview: 'Trigger: 820.0 ms', families: ['mr'] },

  { id: 'detectorType', label: 'Detector Type', group: 'Acquisition', preview: 'Detector: DIRECT', families: ['radiography', 'angiography'] },
  { id: 'exposureIndex', label: 'Exposure Index', group: 'Acquisition', preview: 'EI: 420.0', families: ['radiography'] },
  { id: 'targetExposureIndex', label: 'Target Exposure Index', group: 'Acquisition', preview: 'Target EI: 400.0', families: ['radiography'] },
  { id: 'deviationIndex', label: 'Deviation Index', group: 'Acquisition', preview: 'DI: 0.2', families: ['radiography'] },
  { id: 'primaryAngle', label: 'Primary Angle', group: 'Acquisition', preview: 'Primary: 15.0 deg', families: ['angiography'] },
  { id: 'secondaryAngle', label: 'Secondary Angle', group: 'Acquisition', preview: 'Secondary: -5.0 deg', families: ['angiography'] },
  { id: 'sourceToDetectorDistance', label: 'Source to Detector Distance', group: 'Acquisition', preview: 'SID: 1000.0 mm', families: ['radiography', 'angiography'] },
  { id: 'sourceToPatientDistance', label: 'Source to Patient Distance', group: 'Acquisition', preview: 'SPD: 700.0 mm', families: ['radiography', 'angiography'] },
  { id: 'tableHeight', label: 'Table Height', group: 'Acquisition', preview: 'Table: 85.0 mm', families: ['angiography'] },

  { id: 'transducerData', label: 'Transducer Data', group: 'Acquisition', preview: 'Probe: C5-1', families: ['ultrasound'] },
  { id: 'transducerFrequency', label: 'Transducer Frequency', group: 'Acquisition', preview: 'Probe: 3.50 MHz', families: ['ultrasound'] },
  { id: 'scanFieldDepth', label: 'Depth of Scan Field', group: 'Acquisition', preview: 'Depth: 160.0 mm', families: ['ultrasound'] },
  { id: 'mechanicalIndex', label: 'Mechanical Index', group: 'Acquisition', preview: 'MI: 1.2', families: ['ultrasound'] },
  { id: 'boneThermalIndex', label: 'Bone Thermal Index', group: 'Acquisition', preview: 'TIB: 0.4', families: ['ultrasound'] },

  { id: 'radiopharmaceutical', label: 'Radiopharmaceutical', group: 'Acquisition', preview: 'Drug: 18F-FDG', families: ['nuclear'] },
  { id: 'radionuclide', label: 'Radionuclide', group: 'Acquisition', preview: 'Nuclide: F-18', families: ['nuclear'] },
  { id: 'radionuclideTotalDose', label: 'Radionuclide Total Dose', group: 'Acquisition', preview: 'Dose: 370 MBq', families: ['nuclear'] },
  { id: 'radionuclideHalfLife', label: 'Radionuclide Half Life', group: 'Acquisition', preview: 'Half-life: 6586 s', families: ['nuclear'] },
  { id: 'radiopharmaceuticalStartTime', label: 'Radiopharmaceutical Start Time', group: 'Acquisition', preview: 'Start: 09:15:00', families: ['nuclear'] },
  { id: 'petUnits', label: 'PET Units', group: 'Acquisition', preview: 'Units: BQML', families: ['nuclear'] },
  { id: 'decayCorrection', label: 'Decay Correction', group: 'Acquisition', preview: 'Decay: START', families: ['nuclear'] },
  { id: 'suvType', label: 'SUV Type', group: 'Acquisition', preview: 'SUV: BW', families: ['nuclear'] },
  { id: 'waveformSamplingFrequency', label: 'Sampling Frequency', group: 'Acquisition', preview: 'Sample: 500 Hz', families: ['waveform'] },

  { id: 'sliceLocation', label: 'Slice Location', group: 'Image', preview: 'LOC: -308.70' },
  { id: 'sliceThickness', label: 'Slice Thickness', group: 'Image', preview: 'THK: 1.00' },
  { id: 'sliceSpacing', label: 'Spacing Between Slices', group: 'Image', preview: 'SP: 0.70' },
  { id: 'reconDiameter', label: 'Reconstruction Diameter', group: 'Image', preview: 'DFOV: 241.00' },
  { id: 'imagePosition', label: 'Image Position Patient', group: 'Image', preview: 'IPP: -120.0\\-135.0\\-308.7' },
  { id: 'imageOrientation', label: 'Image Orientation Patient', group: 'Image', preview: 'IOP: 1\\0\\0\\0\\1\\0' },
  { id: 'pixelSpacing', label: 'Pixel Spacing', group: 'Image', preview: 'Pixel: 0.47 x 0.47 mm' },
  { id: 'matrix', label: 'Matrix', group: 'Image', preview: 'Matrix: 512 x 512' },
  { id: 'bitsStored', label: 'Bits Stored', group: 'Image', preview: 'Bits: 12' },
  { id: 'photometric', label: 'Photometric Interpretation', group: 'Image', preview: 'Photo: MONOCHROME2' },
  { id: 'presentationIntent', label: 'Presentation Intent', group: 'Image', preview: 'Intent: FOR PRESENTATION' },
  { id: 'rescaleIntercept', label: 'Rescale Intercept', group: 'Image', preview: 'Intercept: -1024' },
  { id: 'rescaleSlope', label: 'Rescale Slope', group: 'Image', preview: 'Slope: 1.0' },
  { id: 'windowCenter', label: 'Window Center', group: 'Image', preview: 'C: 35' },
  { id: 'windowWidth', label: 'Window Width', group: 'Image', preview: 'W: 80' },
  { id: 'zoom', label: 'Zoom', group: 'Image', preview: 'Z: 1.00' },
  { id: 'page', label: 'Page or Frame', group: 'Image', preview: 'Page: 175 of 348' },
  { id: 'imageNumber', label: 'Image Number', group: 'Image', preview: 'IM: 175 / 348' },
  { id: 'sopInstanceUid', label: 'SOP Instance UID', group: 'Image', preview: 'SOP: 1.3.12.2...' },
  { id: 'frameOfReferenceUid', label: 'Frame of Reference UID', group: 'Image', preview: 'FoR: 1.3.12.2...' },
]

export const overlayFieldById = new Map(overlayFieldDefinitions.map((field) => [field.id, field]))
export const overlayModalityByCode = new Map(overlayModalityDefinitions.map((modality) => [modality.code, modality]))

export function createDefaultViewerOverlayConfig(): ViewerOverlayConfig {
  return { version: 2, profiles: {} }
}

export function normalizeViewerOverlayConfig(value: unknown): ViewerOverlayConfig {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawProfiles = source.profiles && typeof source.profiles === 'object' ? source.profiles as Record<string, unknown> : null
  const profiles: Record<string, ViewerOverlayLayout> = {}

  if (rawProfiles) {
    for (const [profileId, layout] of Object.entries(rawProfiles)) {
      if (profileId !== defaultOverlayProfileId && !overlayModalityByCode.has(profileId)) continue
      profiles[profileId] = normalizeLayout(layout)
    }
  } else if (source.layout) {
    // Preserve the earlier single-layout configuration as the fallback profile.
    profiles[defaultOverlayProfileId] = normalizeLayout(source.layout)
  }

  return { version: 2, profiles }
}

export function getViewerOverlayLayout(config: ViewerOverlayConfig | undefined, modalityCode?: string) {
  const normalized = normalizeViewerOverlayConfig(config)
  const profileId = String(modalityCode ?? '').trim().toUpperCase()
  if (profileId && profileId !== defaultOverlayProfileId) {
    return normalized.profiles[profileId] ?? createDefaultLayout(profileId)
  }

  return normalized.profiles[defaultOverlayProfileId] ?? createDefaultLayout()
}

export function getOverlayFieldDefinitions(modalityCode?: string) {
  const profileId = String(modalityCode ?? '').trim().toUpperCase()
  if (!profileId || profileId === defaultOverlayProfileId) return overlayFieldDefinitions
  const family = overlayModalityByCode.get(profileId)?.family
  return overlayFieldDefinitions.filter((field) => !field.families?.length || (family && field.families.includes(family)))
}

function createDefaultLayout(modalityCode?: string): ViewerOverlayLayout {
  const family = overlayModalityByCode.get(String(modalityCode ?? '').toUpperCase())?.family
  const layout: ViewerOverlayLayout = {
    topLeft: ['patientName', 'patientId'],
    topRight: ['modalityStudy', 'seriesInfo', 'studyDateTime', 'accessionNumber'],
    bottomLeft: ['laterality', 'viewPosition', 'patientPosition', 'page'],
    bottomRight: ['sliceLocation', 'sliceThickness', 'sliceSpacing', 'windowCenter', 'windowWidth', 'zoom', 'imageNumber'],
  }

  if (family === 'ct') {
    layout.bottomLeft = ['kvp', 'tubeCurrent', 'exposureTime', 'ctdiVol', 'pitch', 'kernel', 'gantryTilt', 'page']
    layout.bottomRight = ['sliceLocation', 'sliceThickness', 'sliceSpacing', 'reconDiameter', 'windowCenter', 'windowWidth', 'zoom', 'imageNumber']
  } else if (family === 'mr') {
    layout.bottomLeft = ['tr', 'te', 'ti', 'flipAngle', 'fieldStrength', 'sequenceName', 'page']
    layout.bottomRight = ['sliceLocation', 'sliceThickness', 'sliceSpacing', 'pixelSpacing', 'windowCenter', 'windowWidth', 'zoom', 'imageNumber']
  } else if (family === 'nuclear') {
    layout.bottomLeft = ['radiopharmaceutical', 'radionuclide', 'radionuclideTotalDose', 'petUnits', 'decayCorrection', 'page']
    layout.bottomRight = ['sliceLocation', 'sliceThickness', 'pixelSpacing', 'windowCenter', 'windowWidth', 'zoom', 'imageNumber']
  } else if (family === 'radiography') {
    layout.bottomLeft = ['kvp', 'tubeCurrent', 'exposureTime', 'exposureIndex', 'detectorType', 'page']
    layout.bottomRight = ['laterality', 'viewPosition', 'pixelSpacing', 'windowCenter', 'windowWidth', 'zoom', 'imageNumber']
  } else if (family === 'angiography') {
    layout.bottomLeft = ['kvp', 'tubeCurrent', 'exposureTime', 'primaryAngle', 'secondaryAngle', 'page']
    layout.bottomRight = ['laterality', 'sourceToDetectorDistance', 'sourceToPatientDistance', 'windowCenter', 'windowWidth', 'zoom', 'imageNumber']
  } else if (family === 'ultrasound') {
    layout.bottomLeft = ['transducerData', 'transducerFrequency', 'scanFieldDepth', 'mechanicalIndex', 'boneThermalIndex', 'page']
    layout.bottomRight = ['pixelSpacing', 'windowCenter', 'windowWidth', 'zoom', 'imageNumber']
  } else if (family === 'waveform') {
    layout.bottomLeft = ['waveformSamplingFrequency', 'page']
    layout.bottomRight = ['imageNumber']
  }

  return layout
}

function normalizeLayout(value: unknown): ViewerOverlayLayout {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(overlayCorners.map(({ id }) => [
    id,
    Array.isArray(source[id]) ? sanitizeFieldIds(source[id]) : createDefaultLayout()[id],
  ])) as ViewerOverlayLayout
}

function sanitizeFieldIds(value: unknown[]) {
  const unique = new Set<string>()
  for (const item of value) {
    const id = String(item ?? '')
    if (overlayFieldById.has(id)) unique.add(id)
    if (unique.size >= 24) break
  }
  return [...unique]
}

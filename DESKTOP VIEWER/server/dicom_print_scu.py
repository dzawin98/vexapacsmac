import json
import sys
from pathlib import Path

from pydicom.dataset import Dataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian, ImplicitVRLittleEndian, generate_uid
from pynetdicom import AE
from pynetdicom.sop_class import (
    BasicFilmBox,
    BasicFilmSession,
    BasicGrayscaleImageBox,
    BasicGrayscalePrintManagementMeta,
)


def ensure_success(status, step):
    code = getattr(status, "Status", None)
    if code is None or code not in (0x0000, 0xB000, 0xB600, 0xB601, 0xB602, 0xB603, 0xB604):
        raise RuntimeError(f"{step} failed with status {hex(code) if code is not None else 'unknown'}")


def main():
    config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    pixels = Path(sys.argv[2]).read_bytes()
    width, height = int(config["width"]), int(config["height"])
    if len(pixels) != width * height:
        raise RuntimeError("Invalid grayscale film raster")

    ae = AE(ae_title=str(config.get("callingAet") or "VEXA_PRINT")[:16])
    syntaxes = [ExplicitVRLittleEndian, ImplicitVRLittleEndian]
    ae.add_requested_context(BasicGrayscalePrintManagementMeta, syntaxes)
    ae.add_requested_context(BasicFilmSession, syntaxes)
    ae.add_requested_context(BasicFilmBox, syntaxes)
    ae.add_requested_context(BasicGrayscaleImageBox, syntaxes)
    assoc = ae.associate(str(config["host"]), int(config["port"]), ae_title=str(config["aet"])[:16])
    if not assoc.is_established:
        raise RuntimeError("DICOM Print association was rejected or timed out")

    meta = BasicGrayscalePrintManagementMeta
    film_session_uid = generate_uid()
    film_box_uid = generate_uid()
    try:
        session = Dataset()
        session.NumberOfCopies = str(max(1, int(config.get("copies", 1))))
        session.PrintPriority = "MED"
        session.MediumType = str(config.get("mediumType") or "BLUE FILM")
        session.FilmDestination = str(config.get("filmDestination") or "MAGAZINE")
        status, _ = assoc.send_n_create(session, BasicFilmSession, film_session_uid, meta_uid=meta)
        ensure_success(status, "Film Session N-CREATE")

        referenced_session = Dataset()
        referenced_session.ReferencedSOPClassUID = BasicFilmSession
        referenced_session.ReferencedSOPInstanceUID = film_session_uid
        film_box = Dataset()
        film_box.ImageDisplayFormat = str(config.get("layout") or "STANDARD\\1,1")
        film_box.FilmOrientation = str(config.get("orientation") or "PORTRAIT").upper()
        film_box.FilmSizeID = str(config.get("filmSizeId") or "14INX17IN")
        film_box.MagnificationType = str(config.get("magnificationType") or "REPLICATE")
        film_box.BorderDensity = "BLACK"
        film_box.EmptyImageDensity = "BLACK"
        film_box.ReferencedFilmSessionSequence = Sequence([referenced_session])
        status, response = assoc.send_n_create(film_box, BasicFilmBox, film_box_uid, meta_uid=meta)
        ensure_success(status, "Film Box N-CREATE")
        boxes = getattr(response, "ReferencedImageBoxSequence", None) if response else None
        if not boxes:
            raise RuntimeError("Printer did not return a referenced image box")

        image = Dataset()
        image.SamplesPerPixel = 1
        image.PhotometricInterpretation = "MONOCHROME2"
        image.Rows = height
        image.Columns = width
        image.PixelAspectRatio = [1, 1]
        image.BitsAllocated = 8
        image.BitsStored = 8
        image.HighBit = 7
        image.PixelRepresentation = 0
        image.PixelData = pixels
        image_box = Dataset()
        image_box.ImageBoxPosition = 1
        image_box.BasicGrayscaleImageSequence = Sequence([image])
        box_uid = boxes[0].ReferencedSOPInstanceUID
        status, _ = assoc.send_n_set(image_box, BasicGrayscaleImageBox, box_uid, meta_uid=meta)
        ensure_success(status, "Image Box N-SET")
        status, _ = assoc.send_n_action(None, 1, BasicFilmBox, film_box_uid, meta_uid=meta)
        ensure_success(status, "Film Box N-ACTION")
        print(json.dumps({"ok": True, "jobId": film_box_uid}))
    finally:
        assoc.release()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)

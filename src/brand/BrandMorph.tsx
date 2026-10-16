// The symbol as three live shapes instead of a drawing, so the mark can do what it shows: one square becomes a rounded
// square and a circle (src/brand/brand.css holds the geometry of assets/brand/morfa-symbol.svg and the motion).

type BrandMorphProps = {
  /** `once`: the shapes unfold when the mark appears (the sign-in stage). `loop`: they fold and unfold while something loads. */
  motion: 'once' | 'loop';
  className?: string;
};

/** Decoration: the name of the product is said by the text or the lockup beside it. */
export function BrandMorph({motion, className}: BrandMorphProps) {
  return (
    <span className={`mf-morph is-${motion} ${className ?? ''}`.trim()} aria-hidden="true">
      <i className="mf-morph-square" />
      <i className="mf-morph-rounded" />
      <i className="mf-morph-circle" />
    </span>
  );
}

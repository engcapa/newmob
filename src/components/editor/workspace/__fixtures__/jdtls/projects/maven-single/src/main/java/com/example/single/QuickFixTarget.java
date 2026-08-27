package com.example.single;

/**
 * §8.20.4 W3 quick-fix target: references StringUtils as a simple name
 * WITHOUT importing it, so jdtls publishes an unresolved-type diagnostic and
 * offers the "Import 'StringUtils'" quick fix. The reference sits inside an
 * unreachable block to keep every other scenario position-stable.
 */
public class QuickFixTarget {

    void quickFixTargets() {
        if (false) {
            boolean blank = StringUtils.isBlank("x");
        }
    }
}

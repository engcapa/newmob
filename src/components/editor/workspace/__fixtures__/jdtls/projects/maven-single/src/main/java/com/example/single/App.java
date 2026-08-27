package com.example.single;

import java.util.Arrays;
import java.util.List;

public class App {

    public static void main(String[] args) {
        List<String> names = Arrays.asList("alpha", "beta");
        System.out.println(names.size());
    }

    /**
     * Completion targets sit on bare prefix tokens below; the fixture runner
     * requests completion at the end of each marked token and records what
     * jdtls returns. Unreachable blocks keep every line position-stable while
     * leaving the file compilable.
     */
    void completionTargets() {
        if (false) {
            Stri
        }
        if (false) {
            Arrays.
        }
        if (false) {
            new StringBuilder().appen
        }
        if (false) {
            StringUti
        }
    }

    /**
     * Signature/hover targets for the W1 reference-information evidence:
     * real compilable call expressions whose argument lists the runner walks
     * with textDocument/signatureHelp, plus symbols hovered for
     * textDocument/hover (project javadoc, JDK and library sources).
     */
    void signatureTargets() {
        if (false) {
            StringBuilder sb = new StringBuilder();
            sb.append("alpha");
            sb.append("ab", 0, 1);
            String nested = String.valueOf(Integer.parseInt("42"));
            java.util.Collections.singletonList("x");
            new App().signatureTargets();
            // FQN on purpose: the buffer must NOT import StringUtils so the
            // dependency-source-import completion case still exercises
            // import-on-resolve; the FQN keeps this symbol resolvable for hover.
            org.apache.commons.lang3.StringUtils.isBlank("x");
        }
    }
}

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
}

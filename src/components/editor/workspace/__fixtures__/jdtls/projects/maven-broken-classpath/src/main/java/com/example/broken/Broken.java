package com.example.broken;

/** Broken-classpath targets: MissingUti must NOT complete; Stri still must. */
public class Broken {

    void completionTargets() {
        if (false) {
            MissingUti
        }
        if (false) {
            Stri
        }
    }
}
